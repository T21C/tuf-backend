import { subscribeStream } from '@/server/services/eventBus/index.js';
import { OUTBOX_STREAM_FIELDS } from '@/server/services/eventBus/types.js';
import { OUTBOX_EVENT_TYPES } from '@/server/services/outbox/events.js';
import type { OutboxPayloadByType } from '@/server/services/outbox/events.js';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  handleDiscordLevelFileDeleted,
  handleDiscordLevelFileUpdated,
  handleDiscordLevelFileUploaded,
  handleDiscordLevelMetadataChanged,
  handleDiscordLevelTargetUpdated,
} from '@/server/services/outbox/handlers/discord/levelDiscordHandlers.js';
import {
  runLevelAnnouncementJob,
  runPassAnnouncementJob,
  runRerateAnnouncementJob,
} from '@/server/services/outbox/handlers/discord/announcementJobs.js';

const STREAM = 'outbox:events';

function parsePayload<T>(raw: string): T {
  return JSON.parse(raw || '{}') as T;
}

export function startDiscordOutboxDispatcher(): void {
  subscribeStream({
    stream: STREAM,
    consumerGroup: 'discord-outbox',
    partitionKey: (fields) => fields[OUTBOX_STREAM_FIELDS.id] ?? 'unknown',
    handle: async (fields) => {
      const eventType = fields[OUTBOX_STREAM_FIELDS.eventType];
      const payloadRaw = fields[OUTBOX_STREAM_FIELDS.payload];

      switch (eventType) {
        case OUTBOX_EVENT_TYPES.DiscordLevelFileUpdated:
          await handleDiscordLevelFileUpdated(
            parsePayload<OutboxPayloadByType[typeof OUTBOX_EVENT_TYPES.DiscordLevelFileUpdated]>(payloadRaw),
          );
          break;
        case OUTBOX_EVENT_TYPES.DiscordLevelFileDeleted:
          await handleDiscordLevelFileDeleted(
            parsePayload<OutboxPayloadByType[typeof OUTBOX_EVENT_TYPES.DiscordLevelFileDeleted]>(payloadRaw),
          );
          break;
        case OUTBOX_EVENT_TYPES.DiscordLevelFileUploaded:
          await handleDiscordLevelFileUploaded(
            parsePayload<OutboxPayloadByType[typeof OUTBOX_EVENT_TYPES.DiscordLevelFileUploaded]>(payloadRaw),
          );
          break;
        case OUTBOX_EVENT_TYPES.DiscordLevelTargetUpdated:
          await handleDiscordLevelTargetUpdated(
            parsePayload<OutboxPayloadByType[typeof OUTBOX_EVENT_TYPES.DiscordLevelTargetUpdated]>(payloadRaw),
          );
          break;
        case OUTBOX_EVENT_TYPES.DiscordLevelMetadataChanged:
          await handleDiscordLevelMetadataChanged(
            parsePayload<OutboxPayloadByType[typeof OUTBOX_EVENT_TYPES.DiscordLevelMetadataChanged]>(payloadRaw),
          );
          break;
        case OUTBOX_EVENT_TYPES.DiscordPassBatchAnnouncement:
          await runPassAnnouncementJob(
            parsePayload<OutboxPayloadByType[typeof OUTBOX_EVENT_TYPES.DiscordPassBatchAnnouncement]>(
              payloadRaw,
            ).passIds,
          );
          break;
        case OUTBOX_EVENT_TYPES.DiscordLevelBatchAnnouncement:
          await runLevelAnnouncementJob(
            parsePayload<OutboxPayloadByType[typeof OUTBOX_EVENT_TYPES.DiscordLevelBatchAnnouncement]>(
              payloadRaw,
            ).levelIds,
          );
          break;
        case OUTBOX_EVENT_TYPES.DiscordRerateBatchAnnouncement:
          await runRerateAnnouncementJob(
            parsePayload<OutboxPayloadByType[typeof OUTBOX_EVENT_TYPES.DiscordRerateBatchAnnouncement]>(
              payloadRaw,
            ).levelIds,
          );
          break;
        default:
          logger.warn(`[discord-outbox] Unknown event type: ${eventType}`);
      }
    },
  });

  logger.info('[discord-outbox] Dispatcher subscribed');
}
