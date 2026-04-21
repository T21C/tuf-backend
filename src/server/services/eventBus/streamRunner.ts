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

  const runLoop = async (): Promise<void> => {
    const client = await redis.getClient();
    if (!client) {
      logger.warn(`[eventBus] Redis unavailable; consumer ${options.consumerGroup} on ${options.stream} not started`);
      return;
    }

    try {
      await client.xGroupCreate(options.stream, options.consumerGroup, '0', { MKSTREAM: true });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('BUSYGROUP')) {
        logger.error(`[eventBus] xGroupCreate failed for ${options.stream}:`, e);
        throw e;
      }
    }

    while (!aborted) {
      try {
        const readClient = await redis.getClient();
        if (!readClient) {
          await sleep(2000);
          continue;
        }

        const res = await readClient.xReadGroup(
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
              const execClient = await redis.getClient();
              if (!execClient) return;
              let lastErr: unknown;
              for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                  await options.handle(flat);
                  await execClient.xAck(options.stream, options.consumerGroup, id);
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
              await execClient.xAdd(dlqStream, '*', {
                ...flat,
                _failedStream: options.stream,
                _failedId: id,
                _error: lastErr instanceof Error ? lastErr.message : String(lastErr),
                _attempts: String(maxRetries),
              });
              await execClient.xAck(options.stream, options.consumerGroup, id);
            });
          }
        }
      } catch (loopErr) {
        if (aborted) break;
        logger.error(`[eventBus] read loop error ${options.stream}:`, loopErr);
        await sleep(2000);
      }
    }
  };

  const loopPromise = runLoop();

  registerShutdownStep({
    name: shutdownName,
    priority: 45,
    fn: async () => {
      aborted = true;
      await loopPromise.catch(() => undefined);
      await Promise.all(slotTail);
    },
  });

  return {
    stop: async () => {
      aborted = true;
      unregisterShutdownStep(shutdownName);
      await loopPromise.catch(() => undefined);
      await Promise.all(slotTail);
    },
  };
}
