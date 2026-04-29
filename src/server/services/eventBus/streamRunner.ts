import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { logger } from '@/server/services/core/LoggerService.js';
import { redis } from '@/server/services/core/RedisService.js';
import { registerShutdownStep, unregisterShutdownStep } from '@/server/bootstrap/shutdownCoordinator.js';

const DEFAULT_PARTITION_SLOTS = 16;
const DEFAULT_BLOCK_MS = 5000;
const DEFAULT_BATCH_COUNT = 32;
const DEFAULT_MAX_RETRIES = 6;
const SHUTDOWN_STEP_PREFIX = 'eventbus-stream-';

function simpleHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function streamReadErrorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

function isRecoverableStreamGroupError(err: unknown): boolean {
  const msg = streamReadErrorText(err).toLowerCase();
  return msg.includes('nogroup') || msg.includes('no such key');
}

/** Use the shared Redis client so group creation is not tied to the blocking duplicate socket. */
async function ensureConsumerGroup(stream: string, consumerGroup: string): Promise<void> {
  const client = await redis.getClient();
  if (!client) {
    throw new Error('Redis unavailable for XGROUP CREATE');
  }
  try {
    await client.xGroupCreate(stream, consumerGroup, '0', { MKSTREAM: true });
  } catch (e: unknown) {
    const m = streamReadErrorText(e);
    if (!m.includes('BUSYGROUP')) {
      throw e;
    }
  }
}

export interface SubscribeStreamOptions {
  /** Redis stream key (e.g. `cdc:levels`, `outbox:events`). */
  stream: string;
  /** Consumer group name (stable per stream + logical consumer). */
  consumerGroup: string;
  /** Derive partition key from flat Redis fields for per-slot serialization. */
  partitionKey: (fields: Record<string, string>) => string;
  /** Process one message; throw to trigger retry / DLQ. */
  handle: (fields: Record<string, string>) => Promise<void>;
  partitionSlots?: number;
  blockMs?: number;
  batchCount?: number;
  maxRetries?: number;
}

function messageToStringRecord(message: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(message)) {
    if (typeof v === 'string') {
      out[k] = v;
    } else if (v == null) {
      out[k] = '';
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

/**
 * Long-running Redis Streams consumer with consumer group, per-partition chaining,
 * exponential backoff retries inside the handler loop, DLQ (`<stream>:dlq`), and graceful shutdown.
 */
export function subscribeStream(options: SubscribeStreamOptions): { stop: () => Promise<void> } {
  const partitionSlots = options.partitionSlots ?? DEFAULT_PARTITION_SLOTS;
  const blockMs = options.blockMs ?? DEFAULT_BLOCK_MS;
  const batchCount = options.batchCount ?? DEFAULT_BATCH_COUNT;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const dlqStream = `${options.stream}:dlq`;
  const shutdownName = `${SHUTDOWN_STEP_PREFIX}${options.stream}:${options.consumerGroup}`;
  const consumerName = `${hostname().slice(0, 32)}-${process.pid}-${randomBytes(4).toString('hex')}`;

  const slotTail: Promise<void>[] = Array.from({ length: partitionSlots }, () => Promise.resolve());
  let aborted = false;

  const enqueue = (slot: number, fn: () => Promise<void>): void => {
    const idx = ((slot % partitionSlots) + partitionSlots) % partitionSlots;
    slotTail[idx] = slotTail[idx]!.then(fn).catch((err) => {
      logger.error(`[eventBus] slot ${idx} chain error on ${options.stream}:`, err);
    });
  };

  // Dedicated connections:
  // - `blockingClient` is used for XREADGROUP BLOCK and XACK so it never competes with
  //   request-path cache GETs on the shared client.
  // - DLQ writes go on the shared `redis` client (rare, fire-and-forget).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let blockingClient: any = null;

  const closeBlockingClient = async (): Promise<void> => {
    if (!blockingClient) return;
    try {
      await blockingClient.quit();
    } catch (e) {
      logger.warn(`[eventBus] blocking client quit failed for ${options.stream}:`, e);
    }
    blockingClient = null;
  };

  const runLoop = async (): Promise<void> => {
    blockingClient = await redis.createBlockingClient(`stream:${options.stream}:${options.consumerGroup}`);
    if (!blockingClient) {
      logger.warn(`[eventBus] Redis unavailable; consumer ${options.consumerGroup} on ${options.stream} not started`);
      return;
    }

    try {
      await ensureConsumerGroup(options.stream, options.consumerGroup);
    } catch (e: unknown) {
      logger.error(`[eventBus] xGroupCreate failed for ${options.stream}:`, e);
      throw e;
    }

    while (!aborted) {
      try {
        if (!blockingClient?.isReady) {
          await sleep(500);
          continue;
        }

        const res = await blockingClient.xReadGroup(
          options.consumerGroup,
          consumerName,
          { key: options.stream, id: '>' },
          { COUNT: batchCount, BLOCK: aborted ? 1 : blockMs },
        );

        if (!res || res.length === 0) continue;

        for (const streamEntry of res) {
          for (const msg of streamEntry.messages) {
            const flat = messageToStringRecord(msg.message as Record<string, unknown>);
            const pk = options.partitionKey(flat);
            const slot = simpleHash(`${options.stream}:${pk}`);
            const id = msg.id;

            enqueue(slot, async () => {
              let lastErr: unknown;
              for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                  await options.handle(flat);
                  if (blockingClient?.isReady) {
                    await blockingClient.xAck(options.stream, options.consumerGroup, id);
                  }
                  return;
                } catch (err) {
                  lastErr = err;
                  logger.warn(
                    `[eventBus] handle failed ${options.stream} id=${id} attempt=${attempt}/${maxRetries}`,
                    err,
                  );
                  if (attempt < maxRetries) {
                    const backoff = Math.min(30_000, 200 * 2 ** (attempt - 1));
                    await sleep(backoff);
                  }
                }
              }
              try {
                const shared = await redis.getClient();
                if (shared) {
                  await shared.xAdd(dlqStream, '*', {
                    ...flat,
                    _failedStream: options.stream,
                    _failedId: id,
                    _error: lastErr instanceof Error ? lastErr.message : String(lastErr),
                    _attempts: String(maxRetries),
                  });
                }
              } catch (dlqErr) {
                logger.error(`[eventBus] DLQ write failed for ${options.stream} id=${id}:`, dlqErr);
              }
              if (blockingClient?.isReady) {
                try {
                  await blockingClient.xAck(options.stream, options.consumerGroup, id);
                } catch (ackErr) {
                  logger.error(`[eventBus] xAck (post-DLQ) failed ${options.stream} id=${id}:`, ackErr);
                }
              }
            });
          }
        }
      } catch (loopErr) {
        if (aborted) break;
        const recoverable = isRecoverableStreamGroupError(loopErr);
        if (recoverable) {
          logger.debug(
            `[eventBus] read loop ${options.stream} (recoverable NOGROUP / missing stream): ${streamReadErrorText(loopErr)}`,
          );
          try {
            await ensureConsumerGroup(options.stream, options.consumerGroup);
            logger.debug(`[eventBus] Ensured consumer group for ${options.stream}`);
          } catch (recErr) {
            logger.error(`[eventBus] xGroupCreate recovery failed for ${options.stream}:`, recErr);
          }
        } else {
          logger.error(`[eventBus] read loop error ${options.stream}:`, loopErr);
        }
        await sleep(2000);
      }
    }
  };

  const loopPromise = runLoop();

  const shutdown = async (): Promise<void> => {
    aborted = true;
    await loopPromise.catch(() => undefined);
    await Promise.all(slotTail);
    await closeBlockingClient();
  };

  registerShutdownStep({
    name: shutdownName,
    priority: 45,
    fn: shutdown,
  });

  return {
    stop: async () => {
      unregisterShutdownStep(shutdownName);
      await shutdown();
    },
  };
}
