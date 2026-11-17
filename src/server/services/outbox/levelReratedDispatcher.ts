import {subscribeStream} from '@/server/services/eventBus/index.js';
import {OUTBOX_STREAM_FIELDS} from '@/server/services/eventBus/types.js';
import {OUTBOX_EVENT_TYPES} from '@/server/services/outbox/events.js';
import type {OutboxPayloadByType} from '@/server/services/outbox/events.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {handleLevelRerated} from '@/server/services/notifications/rerateNotify.js';

const STREAM = 'outbox:events';

function parsePayload<T>(raw: string): T {
  return JSON.parse(raw || '{}') as T;
}

export function startLevelReratedDispatcher(): void {
  subscribeStream({
    stream: STREAM,
    consumerGroup: 'level-rerated-fanout',
    partitionKey: (fields) => fields[OUTBOX_STREAM_FIELDS.id] ?? 'unknown',
    handle: async (fields) => {
      const eventType = fields[OUTBOX_STREAM_FIELDS.eventType];
      if (eventType !== OUTBOX_EVENT_TYPES.LevelRerated) {
        return;
      }

      const payload = parsePayload<
        OutboxPayloadByType[typeof OUTBOX_EVENT_TYPES.LevelRerated]
      >(fields[OUTBOX_STREAM_FIELDS.payload]);

      await handleLevelRerated(payload);
    },
  });

  logger.info('[level-rerated] Dispatcher subscribed');
}
