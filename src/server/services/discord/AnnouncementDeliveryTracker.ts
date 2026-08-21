import { createHash } from 'node:crypto';
import { Op } from 'sequelize';
import { redis } from '@/server/services/core/RedisService.js';
import { logger } from '@/server/services/core/LoggerService.js';
import Pass from '@/models/passes/Pass.js';
import Level from '@/models/levels/Level.js';
import { markQueueRowsAnnounced } from '@/server/services/announcements/levelAnnouncementQueue.js';
import { emitFollowFanout } from '@/server/services/notifications/followFanout.js';

export type AnnouncementDeliveryKind = 'pass' | 'level' | 'rerate';

const DELIVERED_TTL_SECONDS = 7 * 24 * 60 * 60;

function hashWebhookUrl(webhookUrl: string): string {
  return createHash('sha256').update(webhookUrl).digest('hex').slice(0, 16);
}

function deliveredKey(kind: AnnouncementDeliveryKind, itemId: number): string {
  return `discord:announce:delivered:${kind}:${itemId}`;
}

function deliveryPairKey(itemId: number, webhookUrl: string): string {
  return `${itemId}\0${webhookUrl}`;
}

/**
 * Tracks which webhook destinations have successfully received each announcement item,
 * then marks DB announced only when all required destinations are done.
 */
export const AnnouncementDeliveryTracker = {
  hashWebhookUrl,
  deliveryPairKey,

  async getDeliveredWebhookHashes(
    kind: AnnouncementDeliveryKind,
    itemId: number,
  ): Promise<Set<string>> {
    const value = await redis.get<string[]>(deliveredKey(kind, itemId));
    return new Set(Array.isArray(value) ? value : []);
  },

  async buildAlreadyDeliveredSet(
    kind: AnnouncementDeliveryKind,
    itemIds: number[],
    webhookUrls: string[],
  ): Promise<Set<string>> {
    const result = new Set<string>();
    await Promise.all(
      itemIds.map(async itemId => {
        const delivered = await this.getDeliveredWebhookHashes(kind, itemId);
        for (const url of webhookUrls) {
          if (delivered.has(hashWebhookUrl(url))) {
            result.add(deliveryPairKey(itemId, url));
          }
        }
      }),
    );
    return result;
  },

  async recordMessageDelivered(options: {
    kind: AnnouncementDeliveryKind;
    itemIds: number[];
    webhookUrl: string;
    /** All webhook URLs this item must reach before DB mark. */
    requiredWebhooksByItemId: Map<number, string[]>;
    /** For level/rerate: map itemId (queue row id) → levelId for Level.isAnnounced */
    levelIdByItemId?: Map<number, number>;
  }): Promise<number[]> {
    const {
      kind,
      itemIds,
      webhookUrl,
      requiredWebhooksByItemId,
      levelIdByItemId,
    } = options;

    if (itemIds.length === 0) return [];

    const webhookHash = hashWebhookUrl(webhookUrl);
    const newlyCompleted: number[] = [];

    for (const itemId of itemIds) {
      const key = deliveredKey(kind, itemId);
      const existing = await redis.get<string[]>(key);
      const set = new Set(Array.isArray(existing) ? existing : []);
      set.add(webhookHash);
      await redis.set(key, [...set], DELIVERED_TTL_SECONDS);

      const required = requiredWebhooksByItemId.get(itemId) || [];
      const requiredHashes = new Set(required.map(hashWebhookUrl));
      const complete =
        requiredHashes.size > 0 &&
        [...requiredHashes].every(h => set.has(h));

      if (complete) {
        newlyCompleted.push(itemId);
      }
    }

    if (newlyCompleted.length === 0) return [];

    try {
      if (kind === 'pass') {
        await Pass.update(
          { isAnnounced: true },
          { where: { id: { [Op.in]: newlyCompleted }, isAnnounced: false } },
        );
      } else {
        await markQueueRowsAnnounced(newlyCompleted);
        const levelIds = newlyCompleted
          .map(id => levelIdByItemId?.get(id))
          .filter((id): id is number => typeof id === 'number');
        if (levelIds.length > 0) {
          await Level.update(
            { isAnnounced: true },
            { where: { id: { [Op.in]: levelIds } } },
          );
        }
      }
      logger.info('[AnnouncementDeliveryTracker] marked announced after full delivery', {
        kind,
        itemIds: newlyCompleted,
      });

      if (kind === 'pass') {
        await emitFollowFanout('pass', newlyCompleted);
      } else if (kind === 'level') {
        const levelIds = newlyCompleted
          .map(id => levelIdByItemId?.get(id))
          .filter((id): id is number => typeof id === 'number');
        await emitFollowFanout('level', levelIds);
      }
    } catch (err) {
      logger.error('[AnnouncementDeliveryTracker] failed to mark announced', err);
      throw err;
    }

    return newlyCompleted;
  },
};
