import { randomUUID } from 'node:crypto';
import { redis } from '@/server/services/core/RedisService.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { sseManager, SSE_SOURCES } from '@/misc/utils/server/sse.js';
import {
  advanceSteps,
  buildSteps,
  completeAllSteps,
  encodeQueuePayload,
  failCurrentStep,
  isTerminalItemStatus,
  shouldRecoverActivePayload,
  shouldSkipEnqueue,
  submissionItemKey,
  type SubmissionAction,
  type SubmissionItemState,
  type SubmissionItemStatus,
  type SubmissionKind,
  type SubmissionQueuePayload,
  type SubmissionRequestOrigin,
  type SubmissionRequestState,
  type SubmissionRequestStatus,
  type SubmissionRequestTree,
  type SubmissionRequestedBy,
} from './submissionJobTypes.js';
import { SUBMISSION_WORKER_LOCK_KEY } from './submissionWorkerLock.js';

export {
  buildSteps,
  encodeQueuePayload,
  parseQueuePayload,
  shouldSkipEnqueue,
  submissionItemKey,
} from './submissionJobTypes.js';
export type {
  SubmissionAction,
  SubmissionItemState,
  SubmissionKind,
  SubmissionQueuePayload,
  SubmissionRequestTree,
  SubmissionStepState,
} from './submissionJobTypes.js';

const TTL_SECONDS = 24 * 60 * 60;
const RECENT_LIMIT = 25;
const QUEUE_KEY = 'submission:queue';
const CONVEYOR_KEY = 'submission:conveyor';
const OPEN_KEY = 'submission:open';
const RECENT_KEY = 'submission:recent';
const ACTIVE_KEY = 'submission:active';
export { SUBMISSION_WORKER_LOCK_KEY };

function requestKey(requestId: string): string {
  return `submission:request:${requestId}`;
}

function itemRedisKey(kind: SubmissionKind, itemId: number): string {
  return `submission:item:${kind}:${itemId}`;
}

async function saveRequest(doc: SubmissionRequestState): Promise<void> {
  await redis.set(requestKey(doc.requestId), doc, TTL_SECONDS);
}

async function saveItem(doc: SubmissionItemState): Promise<void> {
  await redis.set(itemRedisKey(doc.kind, doc.itemId), doc, TTL_SECONDS);
}

async function getRequest(requestId: string): Promise<SubmissionRequestState | null> {
  return redis.get<SubmissionRequestState>(requestKey(requestId));
}

async function getItem(
  kind: SubmissionKind,
  itemId: number,
): Promise<SubmissionItemState | null> {
  return redis.get<SubmissionItemState>(itemRedisKey(kind, itemId));
}

async function touchOpen(requestId: string): Promise<void> {
  await redis.sAdd(OPEN_KEY, requestId);
  const client = await redis.getClient();
  if (client) {
    try {
      await client.expire(OPEN_KEY, TTL_SECONDS);
    } catch {
      /* ignore */
    }
  }
}

async function removeOpen(requestId: string): Promise<void> {
  await redis.sRem(OPEN_KEY, requestId);
}

async function pushRecent(requestId: string): Promise<void> {
  const list = (await redis.get<string[]>(RECENT_KEY)) || [];
  const next = [requestId, ...list.filter(id => id !== requestId)].slice(0, RECENT_LIMIT);
  await redis.set(RECENT_KEY, next, TTL_SECONDS);
}

function broadcast(type: string, data: unknown): void {
  try {
    sseManager.broadcastToSources([SSE_SOURCES.submission], { type, data });
  } catch (err) {
    logger.warn('[SubmissionJobService] SSE broadcast failed', err);
  }
}

async function recomputeRequestStatus(requestId: string): Promise<SubmissionRequestState | null> {
  const req = await getRequest(requestId);
  if (!req) return null;

  const items = await Promise.all(req.itemIds.map(id => getItem(req.kind, id)));
  const statuses = items.map(i => i?.status ?? 'queued');
  const allTerminal = statuses.every(s => isTerminalItemStatus(s as SubmissionItemStatus));
  const anyFailed = statuses.some(s => s === 'failed');
  const anyProcessing = statuses.some(s => s === 'processing');

  let status: SubmissionRequestStatus = req.status;
  if (allTerminal) {
    status = anyFailed && !statuses.some(s => s === 'completed') ? 'failed' : 'completed';
  } else if (anyProcessing) {
    status = 'processing';
  } else {
    status = 'queued';
  }

  if (status !== req.status) {
    const updated: SubmissionRequestState = {
      ...req,
      status,
      updatedAt: Date.now(),
    };
    await saveRequest(updated);
    if (status === 'completed' || status === 'failed') {
      await removeOpen(requestId);
      await pushRecent(requestId);
    }
    broadcast('submission.request.updated', { request: updated });
    return updated;
  }
  return req;
}

async function enqueuePayloads(payloads: SubmissionQueuePayload[]): Promise<void> {
  if (payloads.length === 0) return;
  const client = await redis.getClient();
  if (!client) throw new Error('Redis unavailable');
  await client.rPush(QUEUE_KEY, payloads.map(encodeQueuePayload));
  try {
    await client.expire(QUEUE_KEY, TTL_SECONDS);
  } catch {
    /* ignore */
  }
}

async function claimConveyor(itemKeys: string[]): Promise<void> {
  if (itemKeys.length === 0) return;
  await redis.sAdd(CONVEYOR_KEY, ...itemKeys);
  const client = await redis.getClient();
  if (client) {
    try {
      await client.expire(CONVEYOR_KEY, TTL_SECONDS);
    } catch {
      /* ignore */
    }
  }
}

export const SubmissionJobService = {
  queueKey: QUEUE_KEY,
  activeKey: ACTIVE_KEY,
  lockKey: SUBMISSION_WORKER_LOCK_KEY,

  async createOrMergeRequest(options: {
    kind: SubmissionKind;
    action: SubmissionAction;
    itemIds: number[];
    labelsByItemId?: Map<number, string>;
    levelIdsByItemId?: Map<number, number>;
    origin?: SubmissionRequestOrigin;
    user: { id: string; username?: string | null; nickname?: string | null };
  }): Promise<{
    requestId: string;
    kind: SubmissionKind;
    action: SubmissionAction;
    itemCount: number;
    addedItemCount: number;
    addedItemIds: number[];
    alreadyInFlightIds: number[];
    alreadyCompletedIds: number[];
    merged: boolean;
  }> {
    const { kind, action, user } = options;
    const origin = options.origin === 'auto' ? 'auto' : 'manual';
    const uniqueIds = [...new Set(options.itemIds.filter(id => Number.isFinite(id) && id > 0))];
    const requestId = randomUUID();
    const now = Date.now();
    const requestedBy: SubmissionRequestedBy = {
      userId: user.id,
      username: user.nickname || user.username || user.id,
    };

    const alreadyCompletedIds: number[] = [];
    const alreadyInFlightIds: number[] = [];
    const addedItemIds: number[] = [];
    const payloads: SubmissionQueuePayload[] = [];

    const conveyorMembers = await redis.sMembers(CONVEYOR_KEY);
    const conveyorSet = new Set(conveyorMembers);

    for (const itemId of uniqueIds) {
      const existing = await getItem(kind, itemId);
      const skip = shouldSkipEnqueue(existing?.status);
      const key = submissionItemKey(kind, itemId);

      if (skip === 'done') {
        alreadyCompletedIds.push(itemId);
        continue;
      }

      if (skip === 'inflight' || conveyorSet.has(key)) {
        alreadyInFlightIds.push(itemId);
        if (existing) {
          await saveItem({
            ...existing,
            requestIds: [...new Set([...existing.requestIds, requestId])],
            updatedAt: now,
          });
        }
        continue;
      }

      addedItemIds.push(itemId);
      const label = options.labelsByItemId?.get(itemId) || existing?.label || String(itemId);
      const levelId = options.levelIdsByItemId?.get(itemId) ?? existing?.levelId ?? null;
      await saveItem({
        kind,
        action,
        itemId,
        label,
        levelId,
        status: 'queued',
        steps: buildSteps(kind, action),
        requestIds: [...new Set([...(existing?.requestIds || []), requestId])],
        updatedAt: now,
      });
      payloads.push({
        kind,
        action,
        itemId,
        requestId,
        actorId: user.id,
      });
    }

    await claimConveyor(addedItemIds.map(id => submissionItemKey(kind, id)));
    await enqueuePayloads(payloads);

    const request: SubmissionRequestState = {
      requestId,
      kind,
      action,
      origin,
      requestedBy,
      itemIds: uniqueIds,
      status: addedItemIds.length > 0 ? 'queued' : 'completed',
      createdAt: now,
      updatedAt: now,
    };
    await saveRequest(request);

    if (request.status === 'completed') {
      await pushRecent(requestId);
    } else {
      await touchOpen(requestId);
    }

    const merged = alreadyInFlightIds.length > 0 || alreadyCompletedIds.length > 0;
    const items = (
      await Promise.all(uniqueIds.map(id => getItem(kind, id)))
    ).filter((i): i is SubmissionItemState => !!i);

    broadcast(
      merged ? 'submission.request.merged' : 'submission.request.created',
      {
        request: { ...request, items },
        addedItemIds,
        alreadyInFlightIds,
        alreadyCompletedIds,
      },
    );

    return {
      requestId,
      kind,
      action,
      itemCount: uniqueIds.length,
      addedItemCount: addedItemIds.length,
      addedItemIds,
      alreadyInFlightIds,
      alreadyCompletedIds,
      merged,
    };
  },

  async markItemProcessing(kind: SubmissionKind, itemId: number): Promise<void> {
    const item = await getItem(kind, itemId);
    if (!item || isTerminalItemStatus(item.status)) return;
    const firstPending = item.steps.find(s => s.status === 'pending')?.id;
    const updated: SubmissionItemState = {
      ...item,
      status: 'processing',
      steps: firstPending ? advanceSteps(item.steps, firstPending) : item.steps,
      updatedAt: Date.now(),
    };
    await saveItem(updated);
    broadcast('submission.item.updated', { item: updated });
    for (const requestId of item.requestIds) {
      await recomputeRequestStatus(requestId);
    }
  },

  async markStep(kind: SubmissionKind, itemId: number, stepId: string): Promise<void> {
    const item = await getItem(kind, itemId);
    if (!item || isTerminalItemStatus(item.status)) return;
    const updated: SubmissionItemState = {
      ...item,
      status: 'processing',
      steps: advanceSteps(item.steps, stepId),
      updatedAt: Date.now(),
    };
    await saveItem(updated);
    broadcast('submission.item.updated', { item: updated });
    for (const requestId of item.requestIds) {
      await recomputeRequestStatus(requestId);
    }
  },

  async markItemCompleted(
    kind: SubmissionKind,
    itemId: number,
    extras?: { levelId?: number | null; passId?: number | null },
  ): Promise<void> {
    const item = await getItem(kind, itemId);
    if (!item) return;
    const updated: SubmissionItemState = {
      ...item,
      status: 'completed',
      steps: completeAllSteps(item.steps),
      updatedAt: Date.now(),
      ...(extras?.levelId != null ? { levelId: extras.levelId } : {}),
      ...(extras?.passId != null ? { passId: extras.passId } : {}),
    };
    await saveItem(updated);
    await redis.sRem(CONVEYOR_KEY, submissionItemKey(kind, itemId));
    broadcast('submission.item.completed', { item: updated });
    sseManager.broadcastToSources([SSE_SOURCES.admin], {
      type: 'submissionUpdate',
      data: {
        action: item.action === 'approve'
          ? (kind === 'pass' ? 'create' : 'approve')
          : 'decline',
        submissionId: String(itemId),
        submissionType: kind,
      },
    });
    for (const requestId of item.requestIds) {
      await recomputeRequestStatus(requestId);
    }
  },

  async markItemFailed(
    kind: SubmissionKind,
    itemId: number,
    error: string,
  ): Promise<void> {
    const item = await getItem(kind, itemId);
    if (!item || item.status === 'completed') return;
    const updated: SubmissionItemState = {
      ...item,
      status: 'failed',
      error,
      steps: failCurrentStep(item.steps),
      updatedAt: Date.now(),
    };
    await saveItem(updated);
    await redis.sRem(CONVEYOR_KEY, submissionItemKey(kind, itemId));
    broadcast('submission.item.updated', { item: updated });
    for (const requestId of item.requestIds) {
      const req = await getRequest(requestId);
      if (req) {
        await saveRequest({ ...req, error: error || req.error, updatedAt: Date.now() });
      }
      await recomputeRequestStatus(requestId);
    }
  },

  async getItemState(
    kind: SubmissionKind,
    itemId: number,
  ): Promise<SubmissionItemState | null> {
    return getItem(kind, itemId);
  },

  async setActivePayload(payload: SubmissionQueuePayload | null): Promise<void> {
    if (!payload) {
      await redis.del(ACTIVE_KEY);
      return;
    }
    await redis.set(ACTIVE_KEY, payload, TTL_SECONDS);
  },

  async getActivePayload(): Promise<SubmissionQueuePayload | null> {
    return redis.get<SubmissionQueuePayload>(ACTIVE_KEY);
  },

  async isWorkerLockHeld(): Promise<boolean> {
    const client = await redis.getClient();
    if (!client) return false;
    const value = await client.get(SUBMISSION_WORKER_LOCK_KEY);
    return typeof value === 'string' && value.length > 0;
  },

  async requeueFront(payload: SubmissionQueuePayload): Promise<void> {
    const client = await redis.getClient();
    if (!client) throw new Error('Redis unavailable');
    await client.lPush(QUEUE_KEY, encodeQueuePayload(payload));
  },

  async recoverStaleActive(): Promise<'wait' | 'requeue' | 'clear'> {
    const payload = await redis.get<SubmissionQueuePayload>(ACTIVE_KEY);
    if (!payload) return 'clear';
    const lockHeld = await this.isWorkerLockHeld();
    const item = await getItem(payload.kind, payload.itemId);
    const action = shouldRecoverActivePayload({
      lockHeld,
      itemStatus: item?.status,
    });
    if (action === 'wait') return 'wait';
    if (action === 'requeue') {
      await this.requeueFront(payload);
      logger.warn('[SubmissionJobService] Requeued stale active submission item', {
        kind: payload.kind,
        itemId: payload.itemId,
        requestId: payload.requestId,
      });
    }
    await redis.del(ACTIVE_KEY);
    return action;
  },

  async getSnapshot(): Promise<{
    open: SubmissionRequestTree[];
    recent: SubmissionRequestTree[];
  }> {
    const openIds = await redis.sMembers(OPEN_KEY);
    const recentIds = (await redis.get<string[]>(RECENT_KEY)) || [];

    const hydrate = async (requestId: string): Promise<SubmissionRequestTree | null> => {
      const req = await getRequest(requestId);
      if (!req) return null;
      const items = (
        await Promise.all(req.itemIds.map(id => getItem(req.kind, id)))
      ).filter((i): i is SubmissionItemState => !!i);
      return { ...req, items };
    };

    const open = (await Promise.all(openIds.map(hydrate)))
      .filter((r): r is SubmissionRequestTree => !!r)
      .sort((a, b) => b.createdAt - a.createdAt);

    const recent = (
      await Promise.all(
        recentIds
          .filter(id => !openIds.includes(id))
          .slice(0, RECENT_LIMIT)
          .map(hydrate),
      )
    )
      .filter((r): r is SubmissionRequestTree => !!r)
      .sort((a, b) => b.createdAt - a.createdAt);

    return { open, recent };
  },
};
