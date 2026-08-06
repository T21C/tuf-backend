import { randomUUID } from 'node:crypto';
import { redis } from '@/server/services/core/RedisService.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { sseManager } from '@/misc/utils/server/sse.js';
import { DiscordWebhookGate } from '@/server/services/discord/DiscordWebhookGate.js';
import type { AnnouncementDeliveryKind } from '@/server/services/discord/AnnouncementDeliveryTracker.js';

export type AnnouncementKind = AnnouncementDeliveryKind;

export type AnnouncementRequestStatus =
  | 'queued'
  | 'sending'
  | 'blocked'
  | 'completed'
  | 'failed';

export type AnnouncementItemStatus =
  | 'pending'
  | 'sending'
  | 'delivered'
  | 'failed'
  | 'skipped';

export type AnnouncementBatchStatus = 'pending' | 'sending' | 'sent' | 'failed';

export type AnnouncementRequestedBy = {
  userId: string;
  username: string;
};

export type AnnouncementBatchState = {
  batchId: string;
  webhookLabel: string;
  status: AnnouncementBatchStatus;
  destinationsDone: number;
  destinationsRequired: number;
};

export type AnnouncementItemState = {
  kind: AnnouncementKind;
  itemId: number;
  label: string;
  status: AnnouncementItemStatus;
  batches: AnnouncementBatchState[];
  requestIds: string[];
  updatedAt: number;
};

export type AnnouncementRequestState = {
  requestId: string;
  kind: AnnouncementKind;
  requestedBy: AnnouncementRequestedBy;
  itemIds: number[];
  status: AnnouncementRequestStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
};

export type AnnouncementRequestTree = AnnouncementRequestState & {
  items: AnnouncementItemState[];
};

const TTL_SECONDS = 24 * 60 * 60;
const RECENT_LIMIT = 25;

function requestKey(requestId: string): string {
  return `announcement:request:${requestId}`;
}

function itemKey(kind: AnnouncementKind, itemId: number): string {
  return `announcement:item:${kind}:${itemId}`;
}

function openKey(kind: AnnouncementKind): string {
  return `announcement:open:${kind}`;
}

function recentKey(kind: AnnouncementKind): string {
  return `announcement:recent:${kind}`;
}

function conveyorKey(kind: AnnouncementKind): string {
  return `announcement:conveyor:${kind}`;
}

async function saveRequest(doc: AnnouncementRequestState): Promise<void> {
  await redis.set(requestKey(doc.requestId), doc, TTL_SECONDS);
}

async function saveItem(doc: AnnouncementItemState): Promise<void> {
  await redis.set(itemKey(doc.kind, doc.itemId), doc, TTL_SECONDS);
}

async function getRequest(requestId: string): Promise<AnnouncementRequestState | null> {
  return redis.get<AnnouncementRequestState>(requestKey(requestId));
}

async function getItem(
  kind: AnnouncementKind,
  itemId: number,
): Promise<AnnouncementItemState | null> {
  return redis.get<AnnouncementItemState>(itemKey(kind, itemId));
}

async function touchOpen(kind: AnnouncementKind, requestId: string): Promise<void> {
  await redis.sAdd(openKey(kind), requestId);
  const client = await redis.getClient();
  if (client) {
    try {
      await client.expire(openKey(kind), TTL_SECONDS);
    } catch {
      /* ignore */
    }
  }
}

async function removeOpen(kind: AnnouncementKind, requestId: string): Promise<void> {
  await redis.sRem(openKey(kind), requestId);
}

async function pushRecent(kind: AnnouncementKind, requestId: string): Promise<void> {
  const list = (await redis.get<string[]>(recentKey(kind))) || [];
  const next = [requestId, ...list.filter(id => id !== requestId)].slice(0, RECENT_LIMIT);
  await redis.set(recentKey(kind), next, TTL_SECONDS);
}

function broadcast(type: string, data: unknown): void {
  try {
    sseManager.broadcast({ type, data });
  } catch (err) {
    logger.warn('[AnnouncementJobService] SSE broadcast failed', err);
  }
}

async function recomputeRequestStatus(
  requestId: string,
): Promise<AnnouncementRequestState | null> {
  const req = await getRequest(requestId);
  if (!req) return null;

  const items = await Promise.all(req.itemIds.map(id => getItem(req.kind, id)));
  const statuses = items.map(i => i?.status ?? 'pending');
  const allTerminal = statuses.every(s =>
    s === 'delivered' || s === 'failed' || s === 'skipped',
  );
  const anyFailed = statuses.some(s => s === 'failed');
  const anySending = statuses.some(s => s === 'sending' || s === 'pending');

  let status: AnnouncementRequestStatus = req.status;
  if (allTerminal) {
    status = anyFailed && !statuses.some(s => s === 'delivered') ? 'failed' : 'completed';
  } else if (req.status === 'blocked') {
    status = 'blocked';
  } else if (anySending || statuses.some(s => s === 'sending')) {
    status = 'sending';
  } else if (req.status === 'queued') {
    status = 'queued';
  }

  if (status !== req.status) {
    const updated: AnnouncementRequestState = {
      ...req,
      status,
      updatedAt: Date.now(),
    };
    await saveRequest(updated);
    if (status === 'completed' || status === 'failed') {
      await removeOpen(req.kind, requestId);
      await pushRecent(req.kind, requestId);
    }
    broadcast('announcement.request.updated', { request: updated });
    return updated;
  }
  return req;
}

export const AnnouncementJobService = {
  async createOrMergeRequest(options: {
    kind: AnnouncementKind;
    itemIds: number[];
    labelsByItemId?: Map<number, string>;
    user: { id: string; username?: string | null; nickname?: string | null };
  }): Promise<{
    requestId: string;
    kind: AnnouncementKind;
    itemCount: number;
    addedItemCount: number;
    addedItemIds: number[];
    alreadyInFlightIds: number[];
    alreadyDeliveredIds: number[];
    merged: boolean;
  }> {
    const { kind, user } = options;
    const uniqueIds = [...new Set(options.itemIds.filter(id => Number.isFinite(id) && id > 0))];
    const requestId = randomUUID();
    const now = Date.now();
    const requestedBy: AnnouncementRequestedBy = {
      userId: user.id,
      username: user.nickname || user.username || user.id,
    };

    const alreadyDeliveredIds: number[] = [];
    const alreadyInFlightIds: number[] = [];
    const addedItemIds: number[] = [];

    const conveyorMembers = await redis.sMembers(conveyorKey(kind));
    const conveyorSet = new Set(conveyorMembers.map(Number));

    for (const itemId of uniqueIds) {
      const existing = await getItem(kind, itemId);
      if (existing?.status === 'delivered') {
        alreadyDeliveredIds.push(itemId);
        const requestIds = [...new Set([...(existing.requestIds || []), requestId])];
        await saveItem({ ...existing, requestIds, updatedAt: now });
        continue;
      }

      if (conveyorSet.has(itemId) || existing?.status === 'sending') {
        alreadyInFlightIds.push(itemId);
        const base: AnnouncementItemState = existing || {
          kind,
          itemId,
          label: options.labelsByItemId?.get(itemId) || String(itemId),
          status: 'sending',
          batches: [],
          requestIds: [],
          updatedAt: now,
        };
        await saveItem({
          ...base,
          requestIds: [...new Set([...base.requestIds, requestId])],
          updatedAt: now,
        });
        continue;
      }

      addedItemIds.push(itemId);
      const base: AnnouncementItemState = existing || {
        kind,
        itemId,
        label: options.labelsByItemId?.get(itemId) || String(itemId),
        status: 'pending',
        batches: [],
        requestIds: [],
        updatedAt: now,
      };
      await saveItem({
        ...base,
        label: options.labelsByItemId?.get(itemId) || base.label,
        status: base.status === 'failed' ? 'pending' : base.status,
        requestIds: [...new Set([...base.requestIds, requestId])],
        updatedAt: now,
      });
    }

    // Claim conveyor for ids we will actually enqueue
    if (addedItemIds.length > 0) {
      await redis.sAdd(conveyorKey(kind), ...addedItemIds.map(String));
      const client = await redis.getClient();
      if (client) {
        try {
          await client.expire(conveyorKey(kind), TTL_SECONDS);
        } catch {
          /* ignore */
        }
      }
    }

    const allTrackedIds = [...new Set([...uniqueIds])];
    const request: AnnouncementRequestState = {
      requestId,
      kind,
      requestedBy,
      itemIds: allTrackedIds,
      status: addedItemIds.length > 0 ? 'queued' : 'completed',
      createdAt: now,
      updatedAt: now,
    };
    await saveRequest(request);

    if (request.status === 'completed') {
      await pushRecent(kind, requestId);
    } else {
      await touchOpen(kind, requestId);
    }

    const merged =
      alreadyInFlightIds.length > 0 ||
      alreadyDeliveredIds.length > 0 ||
      addedItemIds.length < uniqueIds.length;

    const items = (
      await Promise.all(allTrackedIds.map(id => getItem(kind, id)))
    ).filter((i): i is AnnouncementItemState => !!i);

    broadcast(
      merged ? 'announcement.request.merged' : 'announcement.request.created',
      {
        request: { ...request, items },
        addedItemIds,
        alreadyInFlightIds,
        alreadyDeliveredIds,
      },
    );

    return {
      requestId,
      kind,
      itemCount: uniqueIds.length,
      addedItemCount: addedItemIds.length,
      addedItemIds,
      alreadyInFlightIds,
      alreadyDeliveredIds,
      merged,
    };
  },

  async markRequestsSending(kind: AnnouncementKind, itemIds: number[]): Promise<void> {
    const requestIds = new Set<string>();
    for (const itemId of itemIds) {
      const item = await getItem(kind, itemId);
      if (!item) continue;
      if (item.status === 'delivered' || item.status === 'skipped') continue;
      await saveItem({ ...item, status: 'sending', updatedAt: Date.now() });
      item.requestIds.forEach(id => requestIds.add(id));
      broadcast('announcement.item.progress', { item: { ...item, status: 'sending' } });
    }
    for (const requestId of requestIds) {
      const req = await getRequest(requestId);
      if (!req || req.status === 'completed' || req.status === 'failed') continue;
      const updated = { ...req, status: 'sending' as const, updatedAt: Date.now() };
      await saveRequest(updated);
      broadcast('announcement.request.updated', { request: updated });
    }
  },

  async upsertBatchForItems(options: {
    kind: AnnouncementKind;
    itemIds: number[];
    batchId: string;
    webhookLabel: string;
    status: AnnouncementBatchStatus;
    destinationsDone?: number;
    destinationsRequired?: number;
  }): Promise<void> {
    const {
      kind,
      itemIds,
      batchId,
      webhookLabel,
      status,
      destinationsDone = 0,
      destinationsRequired = 1,
    } = options;

    for (const itemId of itemIds) {
      const item = await getItem(kind, itemId);
      if (!item) continue;
      const batches = [...(item.batches || [])];
      const idx = batches.findIndex(b => b.batchId === batchId);
      const batch: AnnouncementBatchState = {
        batchId,
        webhookLabel,
        status,
        destinationsDone,
        destinationsRequired,
      };
      if (idx >= 0) batches[idx] = { ...batches[idx], ...batch };
      else batches.push(batch);

      let nextStatus = item.status;
      if (item.status !== 'delivered' && item.status !== 'skipped') {
        if (status === 'sending') nextStatus = 'sending';
        else if (status === 'failed') nextStatus = 'failed';
      }

      const updated: AnnouncementItemState = {
        ...item,
        batches,
        status: nextStatus,
        updatedAt: Date.now(),
      };
      await saveItem(updated);
      broadcast('announcement.batch.updated', { item: updated, batchId });
      broadcast('announcement.item.progress', { item: updated });
    }
  },

  async markItemsDelivered(kind: AnnouncementKind, itemIds: number[]): Promise<void> {
    for (const itemId of itemIds) {
      const item = await getItem(kind, itemId);
      if (!item) continue;
      const updated: AnnouncementItemState = {
        ...item,
        status: 'delivered',
        updatedAt: Date.now(),
        batches: (item.batches || []).map(b =>
          b.status === 'sending' ? { ...b, status: 'sent', destinationsDone: b.destinationsRequired } : b,
        ),
      };
      await saveItem(updated);
      await redis.sRem(conveyorKey(kind), String(itemId));
      broadcast('announcement.item.completed', { item: updated });
      for (const requestId of item.requestIds) {
        await recomputeRequestStatus(requestId);
      }
    }
  },

  /**
   * Terminal status for items that intentionally have no webhook destinations
   * (e.g. difficulty has no matching PASS/LEVEL directives).
   */
  async markItemsSkipped(kind: AnnouncementKind, itemIds: number[]): Promise<void> {
    for (const itemId of itemIds) {
      const item = await getItem(kind, itemId);
      if (!item) continue;
      if (item.status === 'delivered' || item.status === 'skipped') continue;
      const updated: AnnouncementItemState = {
        ...item,
        status: 'skipped',
        updatedAt: Date.now(),
        batches: (item.batches || []).map(b =>
          b.status === 'sending' || b.status === 'pending'
            ? { ...b, status: 'sent', destinationsDone: b.destinationsRequired }
            : b,
        ),
      };
      await saveItem(updated);
      await redis.sRem(conveyorKey(kind), String(itemId));
      broadcast('announcement.item.completed', { item: updated });
      for (const requestId of item.requestIds) {
        await recomputeRequestStatus(requestId);
      }
    }
  },

  async markItemsFailed(
    kind: AnnouncementKind,
    itemIds: number[],
    error?: string,
  ): Promise<void> {
    const requestIds = new Set<string>();
    for (const itemId of itemIds) {
      const item = await getItem(kind, itemId);
      if (!item || item.status === 'delivered') continue;
      const updated: AnnouncementItemState = {
        ...item,
        status: 'failed',
        updatedAt: Date.now(),
        batches: (item.batches || []).map(b =>
          b.status === 'sending' || b.status === 'pending'
            ? { ...b, status: 'failed' }
            : b,
        ),
      };
      await saveItem(updated);
      await redis.sRem(conveyorKey(kind), String(itemId));
      broadcast('announcement.item.progress', { item: updated, error });
      item.requestIds.forEach(id => requestIds.add(id));
    }
    for (const requestId of requestIds) {
      const req = await getRequest(requestId);
      if (!req) continue;
      const updated = {
        ...req,
        status: 'failed' as const,
        error: error || req.error,
        updatedAt: Date.now(),
      };
      await saveRequest(updated);
      broadcast('announcement.request.updated', { request: updated });
      await recomputeRequestStatus(requestId);
    }
  },

  async markKindBlocked(kind: AnnouncementKind, error: string): Promise<void> {
    const openIds = await redis.sMembers(openKey(kind));
    for (const requestId of openIds) {
      const req = await getRequest(requestId);
      if (!req || req.status === 'completed') continue;
      const updated = {
        ...req,
        status: 'blocked' as const,
        error,
        updatedAt: Date.now(),
      };
      await saveRequest(updated);
      broadcast('announcement.request.updated', { request: updated });
    }
  },

  async releaseConveyor(kind: AnnouncementKind, itemIds: number[]): Promise<void> {
    if (itemIds.length === 0) return;
    await redis.sRem(conveyorKey(kind), ...itemIds.map(String));
  },

  async getSnapshot(kind: AnnouncementKind): Promise<{
    kind: AnnouncementKind;
    open: AnnouncementRequestTree[];
    recent: AnnouncementRequestTree[];
    gate: {
      blocked: boolean;
      retryAfterMs: number;
      blockedUntil: number | null;
    };
  }> {
    const openIds = await redis.sMembers(openKey(kind));
    const recentIds = (await redis.get<string[]>(recentKey(kind))) || [];

    const hydrate = async (requestId: string): Promise<AnnouncementRequestTree | null> => {
      const req = await getRequest(requestId);
      if (!req) return null;
      const items = (
        await Promise.all(req.itemIds.map(id => getItem(kind, id)))
      ).filter((i): i is AnnouncementItemState => !!i);
      return { ...req, items };
    };

    const open = (await Promise.all(openIds.map(hydrate)))
      .filter((r): r is AnnouncementRequestTree => !!r)
      .sort((a, b) => b.createdAt - a.createdAt);

    const recent = (
      await Promise.all(
        recentIds
          .filter(id => !openIds.includes(id))
          .slice(0, RECENT_LIMIT)
          .map(hydrate),
      )
    )
      .filter((r): r is AnnouncementRequestTree => !!r)
      .sort((a, b) => b.createdAt - a.createdAt);

    const retryAfterMs = await DiscordWebhookGate.getBlockedRemainingMs();
    const blockedUntil = retryAfterMs > 0 ? Date.now() + retryAfterMs : null;

    return {
      kind,
      open,
      recent,
      gate: {
        blocked: retryAfterMs > 0,
        retryAfterMs,
        blockedUntil,
      },
    };
  },

  broadcastGateChanged(): void {
    void (async () => {
      const retryAfterMs = await DiscordWebhookGate.getBlockedRemainingMs();
      broadcast('discord.gate.changed', {
        blocked: retryAfterMs > 0,
        retryAfterMs,
        blockedUntil: retryAfterMs > 0 ? Date.now() + retryAfterMs : null,
      });
    })();
  },
};
