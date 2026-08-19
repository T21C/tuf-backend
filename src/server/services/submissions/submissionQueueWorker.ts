import { randomUUID } from 'node:crypto';
import { redis } from '@/server/services/core/RedisService.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { registerShutdownStep } from '@/server/bootstrap/shutdownCoordinator.js';
import { SubmissionJobService } from './SubmissionJobService.js';
import { processQueuedSubmission } from './submissionProcessors.js';
import {
  acquireSubmissionWorkerLock,
  refreshSubmissionWorkerLock,
  releaseSubmissionWorkerLock,
} from './submissionWorkerLock.js';
import {
  isTerminalItemStatus,
  parseQueuePayload,
  type SubmissionQueuePayload,
} from './submissionJobTypes.js';

const LOCK_REFRESH_MS = 60_000;
const BLPOP_TIMEOUT_SECONDS = 5;

let stopping = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let blockingClient: any = null;
let loopPromise: Promise<void> | null = null;

export async function runQueuedSubmissionItem(
  payload: SubmissionQueuePayload,
): Promise<'completed' | 'failed' | 'skipped'> {
  const existing = await SubmissionJobService.getItemState(payload.kind, payload.itemId);
  if (existing && isTerminalItemStatus(existing.status)) {
    return 'skipped';
  }

  await SubmissionJobService.markItemProcessing(payload.kind, payload.itemId);
  try {
    const result = await processQueuedSubmission(payload, async stepId => {
      await SubmissionJobService.markStep(payload.kind, payload.itemId, stepId);
    });
    await SubmissionJobService.markItemCompleted(payload.kind, payload.itemId, result);
    return 'completed';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await SubmissionJobService.markItemFailed(payload.kind, payload.itemId, message);
    logger.error('[submissionQueueWorker] Item failed', {
      kind: payload.kind,
      action: payload.action,
      itemId: payload.itemId,
      requestId: payload.requestId,
      error: message,
    });
    return 'failed';
  }
}

async function processWithLock(payload: SubmissionQueuePayload, token: string): Promise<void> {
  const client = await redis.getClient();
  if (!client) throw new Error('Redis unavailable');

  await SubmissionJobService.setActivePayload(payload);
  const refreshTimer = setInterval(() => {
    void refreshSubmissionWorkerLock(client, token).catch(err => {
      logger.warn('[submissionQueueWorker] Failed to refresh lock', err);
    });
  }, LOCK_REFRESH_MS);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();

  try {
    await runQueuedSubmissionItem(payload);
  } finally {
    clearInterval(refreshTimer);
    await SubmissionJobService.setActivePayload(null);
    await releaseSubmissionWorkerLock(client, token);
  }
}

async function waitForLockThenProcess(payload: SubmissionQueuePayload): Promise<void> {
  const client = await redis.getClient();
  if (!client) {
    await SubmissionJobService.requeueFront(payload);
    return;
  }

  while (!stopping) {
    const token = randomUUID();
    const acquired = await acquireSubmissionWorkerLock(client, token);
    if (acquired) {
      await processWithLock(payload, token);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  await SubmissionJobService.requeueFront(payload);
}

async function popPayload(): Promise<SubmissionQueuePayload | null> {
  if (!blockingClient) return null;
  const result = await blockingClient.blPop(SubmissionJobService.queueKey, BLPOP_TIMEOUT_SECONDS);
  const raw = typeof result === 'string'
    ? result
    : result?.element;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const payload = parseQueuePayload(raw);
  if (!payload) {
    logger.warn('[submissionQueueWorker] Dropped malformed queue payload');
    return null;
  }
  return payload;
}

async function runLoop(): Promise<void> {
  try {
    await SubmissionJobService.recoverStaleActive();
  } catch (error) {
    logger.warn('[submissionQueueWorker] Stale active recovery failed', error);
  }

  while (!stopping) {
    try {
      await SubmissionJobService.recoverStaleActive();
      const payload = await popPayload();
      if (!payload) continue;
      await waitForLockThenProcess(payload);
    } catch (error) {
      if (stopping) return;
      logger.error('[submissionQueueWorker] Loop error', error);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

export function startSubmissionQueueWorker(): void {
  if (loopPromise) return;
  stopping = false;

  void (async () => {
    blockingClient = await redis.createBlockingClient('submission-queue');
    if (!blockingClient) {
      logger.warn('[submissionQueueWorker] Blocking Redis client unavailable; worker not started');
      return;
    }
    logger.info('[submissionQueueWorker] Started sequential submission worker');
    loopPromise = runLoop().finally(() => {
      loopPromise = null;
    });
  })();

  registerShutdownStep({
    name: 'submission-queue-worker',
    priority: 46,
    fn: stopSubmissionQueueWorker,
  });
}

export async function stopSubmissionQueueWorker(): Promise<void> {
  stopping = true;
  if (blockingClient) {
    try {
      await blockingClient.quit();
    } catch {
      /* ignore */
    }
    blockingClient = null;
  }
  if (loopPromise) {
    await Promise.race([
      loopPromise,
      new Promise(resolve => setTimeout(resolve, 2000)),
    ]);
  }
}
