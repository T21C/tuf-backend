import OutboxEvent from '@/models/outbox/OutboxEvent.js';
import { redis } from '@/server/services/core/RedisService.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { OUTBOX_STREAM_FIELDS } from '@/server/services/eventBus/types.js';
import sequelize from '@/config/db.js';

const STREAM = 'outbox:events';
const POLL_MS = 250;

let intervalHandle: ReturnType<typeof setInterval> | null = null;

async function publishBatch(): Promise<void> {
  const client = await redis.getClient();
  if (!client) return;

  await sequelize.transaction(async (t) => {
      const rows = await OutboxEvent.findAll({
        where: { publishedAt: null },
        order: [['id', 'ASC']],
        limit: 200,
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      for (const row of rows) {
        await client.xAdd(STREAM, '*', {
          [OUTBOX_STREAM_FIELDS.id]: String(row.id),
          [OUTBOX_STREAM_FIELDS.eventType]: row.eventType,
          [OUTBOX_STREAM_FIELDS.aggregate]: row.aggregate,
          [OUTBOX_STREAM_FIELDS.aggregateId]: row.aggregateId,
          [OUTBOX_STREAM_FIELDS.payload]: JSON.stringify(row.payload ?? {}),
          [OUTBOX_STREAM_FIELDS.dedupKey]: row.dedupKey ?? '',
        });
        await row.update({ publishedAt: new Date() }, { transaction: t });
      }
    });
}

export function startOutboxRelay(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    void publishBatch().catch((e) => logger.error('[outbox-relay] publish error:', e));
  }, POLL_MS);
  logger.info('[outbox-relay] Started');
}

export function stopOutboxRelay(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
