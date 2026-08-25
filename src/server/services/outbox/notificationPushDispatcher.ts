import webpush from 'web-push';
import {subscribeStream} from '@/server/services/eventBus/index.js';
import {OUTBOX_STREAM_FIELDS} from '@/server/services/eventBus/types.js';
import {OUTBOX_EVENT_TYPES} from '@/server/services/outbox/events.js';
import type {OutboxPayloadByType} from '@/server/services/outbox/events.js';
import {logger} from '@/server/services/core/LoggerService.js';
import Notification from '@/models/notifications/Notification.js';
import NotificationPreference from '@/models/notifications/NotificationPreference.js';
import NotificationCategoryPreference from '@/models/notifications/NotificationCategoryPreference.js';
import NotificationUserSettings from '@/models/notifications/NotificationUserSettings.js';
import PushSubscription from '@/models/notifications/PushSubscription.js';
import {clientUrlEnv, getVapidConfig, isPushAvailable} from '@/config/app.config.js';
import {serializeNotification} from '@/server/services/notifications/NotificationService.js';
import {
  channelEnabled,
  getNotificationTypeDefinition,
  isNotificationType,
} from '@/server/services/notifications/types.js';
import {renderPushCopy} from '@/server/services/notifications/copy/pushCopy.js';
import {resolvePushArtwork} from '@/server/services/notifications/pushArtwork.js';
import {consumePushHourlySlot} from '@/server/services/notifications/pushHourlyCap.js';
import {
  shouldDropPushSubscription,
  shouldSendPush,
  webPushStatusCode,
} from '@/server/services/notifications/pushDispatchPolicy.js';

const STREAM = 'outbox:events';

function parsePayload<T>(raw: string): T {
  return JSON.parse(raw || '{}') as T;
}

function categoryInAppEnabled(override: boolean | undefined): boolean {
  if (typeof override === 'boolean') return override;
  return true;
}

function absoluteHref(href: string | null): string | null {
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) return href;
  const origin = String(clientUrlEnv || '').replace(/\/$/, '');
  if (!origin) return href;
  return `${origin}${href.startsWith('/') ? href : `/${href}`}`;
}

function ensureVapid(): boolean {
  const config = getVapidConfig();
  if (!config) return false;
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return true;
}

async function dispatchPush(notificationId: number): Promise<void> {
  if (!isPushAvailable() || !ensureVapid()) return;

  const row = await Notification.findByPk(notificationId);
  if (!row || row.hiddenAt) return;

  const [settings, typePref, categoryPref, subscriptions] = await Promise.all([
    NotificationUserSettings.findByPk(row.userId),
    isNotificationType(row.type)
      ? NotificationPreference.findOne({where: {userId: row.userId, type: row.type}})
      : Promise.resolve(null),
    isNotificationType(row.type)
      ? NotificationCategoryPreference.findOne({
          where: {
            userId: row.userId,
            category: getNotificationTypeDefinition(row.type).category,
          },
        })
      : Promise.resolve(null),
    PushSubscription.findAll({where: {userId: row.userId}}),
  ]);

  if (!subscriptions.length) return;

  const definition = isNotificationType(row.type) ? getNotificationTypeDefinition(row.type) : null;
  const inApp = definition
    ? channelEnabled(definition, 'inApp', typePref?.inApp)
    : false;
  const categoryInApp = categoryInAppEnabled(categoryPref?.inApp);
  if (
    !shouldSendPush({
      pushAvailable: true,
      pushEnabled: Boolean(settings?.pushEnabled),
      inApp,
      categoryInApp,
      overHourlyCap: false,
    })
  ) {
    return;
  }

  const cap = await consumePushHourlySlot(row.userId);
  if (!cap.allowed) return;

  const serialized = serializeNotification(row);
  const payloadRecord =
    row.payload && typeof row.payload === 'object' ? (row.payload as Record<string, unknown>) : {};
  const artwork = await resolvePushArtwork(payloadRecord);
  const href = absoluteHref(serialized.href);

  for (const sub of subscriptions) {
    const {title, body} = renderPushCopy(sub.locale, row.type, payloadRecord);
    const payload = JSON.stringify({
      title,
      body,
      href,
      notificationId: serialized.id,
      image: artwork.image,
      icon: artwork.icon,
    });
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {p256dh: sub.p256dh, auth: sub.auth},
        },
        payload,
        {TTL: 60 * 60 * 12},
      );
    } catch (error) {
      const status = webPushStatusCode(error);
      if (shouldDropPushSubscription(status)) {
        await PushSubscription.destroy({where: {id: sub.id}});
        logger.debug('[notification-push] Dropped dead subscription', {
          userId: row.userId,
          status,
        });
        continue;
      }
      throw error;
    }
  }
}

export function startNotificationPushDispatcher(): void {
  subscribeStream({
    stream: STREAM,
    consumerGroup: 'notification-push',
    partitionKey: (fields) => fields[OUTBOX_STREAM_FIELDS.id] ?? 'unknown',
    handle: async (fields) => {
      const eventType = fields[OUTBOX_STREAM_FIELDS.eventType];
      if (eventType !== OUTBOX_EVENT_TYPES.NotificationCreated) {
        return;
      }

      const payload = parsePayload<
        OutboxPayloadByType[typeof OUTBOX_EVENT_TYPES.NotificationCreated]
      >(fields[OUTBOX_STREAM_FIELDS.payload]);

      await dispatchPush(payload.notificationId);
    },
  });

  logger.info('[notification-push] Dispatcher subscribed');
}
