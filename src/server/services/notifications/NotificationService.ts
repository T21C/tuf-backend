import type {Transaction} from 'sequelize';
import {Op} from 'sequelize';
import Notification from '@/models/notifications/Notification.js';
import NotificationPreference from '@/models/notifications/NotificationPreference.js';
import NotificationCategoryPreference from '@/models/notifications/NotificationCategoryPreference.js';
import {OutboxService} from '@/server/services/outbox/OutboxService.js';
import {OUTBOX_EVENT_TYPES} from '@/server/services/outbox/events.js';
import {mapMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {
  resolveRecipientUserIds,
  type NotificationRecipients,
} from './recipients.js';
import {
  channelEnabled,
  getNotificationTypeDefinition,
  isNotificationCategory,
  isNotificationType,
  listNotificationCategories,
  listNotificationTypeDefinitions,
  resolveNotificationHref,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationPayloadByType,
  type NotificationType,
} from './types.js';

export type {NotificationRecipients};

export interface NotifyArgs<K extends NotificationType> {
  type: K;
  payload: NotificationPayloadByType[K];
  recipients: NotificationRecipients;
  dedupKey?: string | null;
  groupKey?: string | null;
  entity?: {type: string; id: string} | null;
  actorId?: string | null;
  skipActor?: boolean;
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
  categoryInApp: boolean;
  email: boolean;
  discord: boolean;
  lockedChannels: Partial<Record<NotificationChannel, boolean>>;
}

export interface EffectiveCategoryPreference {
  category: NotificationCategory;
  inApp: boolean;
}

export interface PreferenceState {
  preferences: EffectivePreference[];
  categories: EffectiveCategoryPreference[];
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

function categoryInAppEnabled(override: boolean | undefined): boolean {
  if (typeof override === 'boolean') return override;
  return true;
}

class NotificationService {
  async notify<K extends NotificationType>(args: NotifyArgs<K>): Promise<void> {
    const definition = getNotificationTypeDefinition(args.type);
    const payload = definition.payload.parse(args.payload);
    const skipActor = args.skipActor !== false;
    const userIds = (await resolveRecipientUserIds(args.recipients, args.transaction)).filter(
      (userId) => !skipActor || !args.actorId || userId !== args.actorId,
    );
    if (!userIds.length) return;

    const [prefs, categoryPrefs] = await Promise.all([
      NotificationPreference.findAll({
        where: {userId: {[Op.in]: userIds}, type: args.type},
        transaction: args.transaction,
      }),
      NotificationCategoryPreference.findAll({
        where: {userId: {[Op.in]: userIds}, category: definition.category},
        transaction: args.transaction,
      }),
    ]);
    const prefByUser = new Map(prefs.map((row) => [row.userId, row]));
    const categoryPrefByUser = new Map(categoryPrefs.map((row) => [row.userId, row]));

    for (const userId of userIds) {
      const pref = prefByUser.get(userId);
      const categoryPref = categoryPrefByUser.get(userId);
      if (!channelEnabled(definition, 'inApp', pref?.inApp)) continue;
      if (!categoryInAppEnabled(categoryPref?.inApp)) continue;

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
      order: [['id', 'DESC']],
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

  async getPreferenceState(userId: string): Promise<PreferenceState> {
    const [typeRows, categoryRows] = await Promise.all([
      NotificationPreference.findAll({where: {userId}}),
      NotificationCategoryPreference.findAll({where: {userId}}),
    ]);
    const byType = new Map(typeRows.map((row) => [row.type, row]));
    const byCategory = new Map(categoryRows.map((row) => [row.category, row]));

    const categories: EffectiveCategoryPreference[] = listNotificationCategories().map(
      (category) => ({
        category,
        inApp: categoryInAppEnabled(byCategory.get(category)?.inApp),
      }),
    );
    const categoryEnabled = new Map(categories.map((row) => [row.category, row.inApp]));

    const preferences = listNotificationTypeDefinitions().map((definition) => {
      const override = byType.get(definition.id);
      const categoryInApp = categoryEnabled.get(definition.category) ?? true;
      return {
        type: definition.id,
        category: definition.category,
        i18nKey: definition.i18nKey,
        categoryInApp,
        inApp: categoryInApp && channelEnabled(definition, 'inApp', override?.inApp),
        email: channelEnabled(definition, 'email', override?.email),
        discord: channelEnabled(definition, 'discord', override?.discord),
        lockedChannels: definition.lockedChannels,
      };
    });

    return {preferences, categories};
  }

  async upsertInAppPreference(
    userId: string,
    type: string,
    inApp: boolean,
  ): Promise<EffectivePreference | null> {
    if (!isNotificationType(type)) return null;
    const definition = getNotificationTypeDefinition(type);
    if (definition.lockedChannels.inApp) {
      return (await this.getPreferenceState(userId)).preferences.find((row) => row.type === type) ?? null;
    }

    const existing = await NotificationPreference.findOne({where: {userId, type}});
    await NotificationPreference.upsert({
      userId,
      type,
      inApp,
      email: existing?.email ?? definition.defaults.email,
      discord: existing?.discord ?? definition.defaults.discord,
    });

    return (await this.getPreferenceState(userId)).preferences.find((row) => row.type === type) ?? null;
  }

  async upsertCategoryInAppPreference(
    userId: string,
    category: string,
    inApp: boolean,
  ): Promise<PreferenceState | null> {
    if (!isNotificationCategory(category)) return null;
    await NotificationCategoryPreference.upsert({userId, category, inApp});
    return this.getPreferenceState(userId);
  }
}

export const notificationService = new NotificationService();
