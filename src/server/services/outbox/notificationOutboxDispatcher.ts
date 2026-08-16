import {subscribeStream} from '@/server/services/eventBus/index.js';
import {OUTBOX_STREAM_FIELDS} from '@/server/services/eventBus/types.js';
import {OUTBOX_EVENT_TYPES} from '@/server/services/outbox/events.js';
import type {OutboxPayloadByType} from '@/server/services/outbox/events.js';
import {logger} from '@/server/services/core/LoggerService.js';
import Notification from '@/models/notifications/Notification.js';
import {serializeNotification} from '@/server/services/notifications/NotificationService.js';
import {sseManager} from '@/misc/utils/server/sse.js';

const STREAM = 'outbox:events';

function parsePayload<T>(raw: string): T {
  return JSON.parse(raw || '{}') as T;
}

export function startNotificationOutboxDispatcher(): void {
  subscribeStream({
    stream: STREAM,
    consumerGroup: 'notification-outbox',
    partitionKey: (fields) => fields[OUTBOX_STREAM_FIELDS.id] ?? 'unknown',
    handle: async (fields) => {
      const eventType = fields[OUTBOX_STREAM_FIELDS.eventType];
      if (eventType !== OUTBOX_EVENT_TYPES.NotificationCreated) {
        return;
      }

      const payload = parsePayload<
        OutboxPayloadByType[typeof OUTBOX_EVENT_TYPES.NotificationCreated]
      >(fields[OUTBOX_STREAM_FIELDS.payload]);

      const row = await Notification.findByPk(payload.notificationId);
      if (!row) {
        logger.debug('[notification-outbox] Row missing', {
          notificationId: payload.notificationId,
        });
        return;
      }

      await sseManager.fanoutToUser(row.userId, {
        type: 'inboxNotification',
        data: serializeNotification(row),
      });
    },
  });

  logger.info('[notification-outbox] Dispatcher subscribed');
}
