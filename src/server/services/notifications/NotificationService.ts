import type {Transaction} from 'sequelize';
import {Op} from 'sequelize';
import User from '@/models/auth/User.js';
import Notification from '@/models/notifications/Notification.js';
import NotificationPreference from '@/models/notifications/NotificationPreference.js';
import {OutboxService} from '@/server/services/outbox/OutboxService.js';
import {OUTBOX_EVENT_TYPES} from '@/server/services/outbox/events.js';
import {mapMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {
  channelEnabled,
  getNotificationTypeDefinition,
  isNotificationType,
  listNotificationTypeDefinitions,
  resolveNotificationHref,
  type NotificationChannel,
  type NotificationPayloadByType,
  type NotificationType,
} from './types.js';

export interface NotificationRecipients {
  userIds?: string[];
  playerIds?: number[];
}

export interface NotifyArgs<K extends NotificationType> {
  type: K;
  payload: NotificationPayloadByType[K];
  recipients: NotificationRecipients;
  dedupKey?: string | null;
  groupKey?: string | null;
  entity?: {type: string; id: string} | null;
  actorId?: string | null;
  transaction?: Transaction;
}

export interface SerializedNotification {
  id: number;
  type: string;
  payload: unknown;
  href: string | null;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
  seenAt: string | null;
  createdAt: string;
}

export interface EffectivePreference {
  type: NotificationType;
  category: string;
  i18nKey: string;
  inApp: boolean;
  email: boolean;
  discord: boolean;
  lockedChannels: Partial<Record<NotificationChannel, boolean>>;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function serializeNotification(row: Notification): SerializedNotification {
  const createdAt = toIso(row.createdAt) ?? new Date().toISOString();
  return {
    id: Number(row.id),
    type: row.type,
    payload: row.payload,
    href: resolveNotificationHref(row.type, row.payload),
    entityType: row.entityType,
    entityId: row.entityId,
    readAt: toIso(row.readAt),
    seenAt: toIso(row.seenAt),
    createdAt,
  };
}

async function resolveRecipientUserIds(
  recipients: NotificationRecipients,
  transaction?: Transaction,
): Promise<string[]> {
  const ids = new Set<string>();
  for (const userId of recipients.userIds ?? []) {
    if (typeof userId === 'string' && userId.trim()) ids.add(userId);
  }

  const playerIds = [...new Set((recipients.playerIds ?? []).filter((id) => Number.isFinite(id)))];
  if (playerIds.length) {
    const users = await User.findAll({
      attributes: ['id'],
      where: {playerId: {[Op.in]: playerIds}},
      transaction,
    });
    for (const user of users) ids.add(user.id);
  }

  return [...ids];
}

class NotificationService {
  async notify<K extends NotificationType>(args: NotifyArgs<K>): Promise<void> {
    const definition = getNotificationTypeDefinition(args.type);
    const payload = definition.payload.parse(args.payload);
    const userIds = await resolveRecipientUserIds(args.recipients, args.transaction);
    if (!userIds.length) return;

    const prefs = await NotificationPreference.findAll({
      where: {userId: {[Op.in]: userIds}, type: args.type},
      transaction: args.transaction,
    });
    const prefByUser = new Map(prefs.map((row) => [row.userId, row]));

    for (const userId of userIds) {
      const pref = prefByUser.get(userId);
      if (!channelEnabled(definition, 'inApp', pref?.inApp)) continue;

      let row: Notification;
      try {
        row = await Notification.create(
          {
            userId,
            type: args.type,
            payload,
            actorId: args.actorId ?? null,
            entityType: args.entity?.type ?? null,
            entityId: args.entity?.id ?? null,
            groupKey: args.groupKey ?? null,
            dedupKey: args.dedupKey ?? null,
          },
          {transaction: args.transaction},
        );
      } catch (err) {
        if (mapMysqlClientError(err)?.code === 'ER_DUP_ENTRY') {
          logger.debug('[notifications] Dedup skip', {
            userId,
            type: args.type,
            dedupKey: args.dedupKey,
          });
          continue;
        }
        throw err;
      }

      await OutboxService.emit(OUTBOX_EVENT_TYPES.NotificationCreated, {
        aggregate: 'notification',
        aggregateId: String(row.id),
        payload: {notificationId: Number(row.id), userId, type: args.type},
        dedupKey: `inbox:${row.id}`,
        transaction: args.transaction,
      });
    }
  }

  async listForUser(
    userId: string,
    args: {cursor?: number | null; limit: number},
  ): Promise<{notifications: SerializedNotification[]; nextCursor: number | null}> {
    const where: Record<string, unknown> = {userId};
    if (args.cursor) {
      where.id = {[Op.lt]: args.cursor};
    }

    const rows = await Notification.findAll({
      where,
      order: [
        ['id', 'DESC'],
      ],
      limit: args.limit + 1,
    });

    const hasMore = rows.length > args.limit;
    const page = hasMore ? rows.slice(0, args.limit) : rows;
    const last = page[page.length - 1];
    return {
      notifications: page.map(serializeNotification),
      nextCursor: hasMore && last ? Number(last.id) : null,
    };
  }

  async unreadCount(userId: string): Promise<number> {
    return Notification.count({
      where: {userId, readAt: null},
    });
  }

  async markRead(userId: string, notificationId: number): Promise<SerializedNotification | null> {
    const row = await Notification.findOne({
      where: {id: notificationId, userId},
    });
    if (!row) return null;
    if (!row.readAt) {
      await row.update({readAt: new Date(), seenAt: row.seenAt ?? new Date()});
    }
    return serializeNotification(row);
  }

  async markAllRead(userId: string): Promise<number> {
    const now = new Date();
    const [count] = await Notification.update(
      {readAt: now, seenAt: now},
      {where: {userId, readAt: null}},
    );
    return count;
  }

  async markSeen(userId: string): Promise<number> {
    const now = new Date();
    const [count] = await Notification.update(
      {seenAt: now},
      {where: {userId, seenAt: null}},
    );
    return count;
  }

  async getPreferences(userId: string): Promise<EffectivePreference[]> {
    const rows = await NotificationPreference.findAll({where: {userId}});
    const byType = new Map(rows.map((row) => [row.type, row]));

    return listNotificationTypeDefinitions().map((definition) => {
      const override = byType.get(definition.id);
      return {
        type: definition.id,
        category: definition.category,
        i18nKey: definition.i18nKey,
        inApp: channelEnabled(definition, 'inApp', override?.inApp),
        email: channelEnabled(definition, 'email', override?.email),
        discord: channelEnabled(definition, 'discord', override?.discord),
        lockedChannels: definition.lockedChannels,
      };
    });
  }

  async upsertInAppPreference(
    userId: string,
    type: string,
    inApp: boolean,
  ): Promise<EffectivePreference | null> {
    if (!isNotificationType(type)) return null;
    const definition = getNotificationTypeDefinition(type);
    if (definition.lockedChannels.inApp) {
      return (await this.getPreferences(userId)).find((row) => row.type === type) ?? null;
    }

    const existing = await NotificationPreference.findOne({where: {userId, type}});
    await NotificationPreference.upsert({
      userId,
      type,
      inApp,
      email: existing?.email ?? definition.defaults.email,
      discord: existing?.discord ?? definition.defaults.discord,
    });

    return (await this.getPreferences(userId)).find((row) => row.type === type) ?? null;
  }
}

export const notificationService = new NotificationService();
