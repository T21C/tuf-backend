import type { Transaction } from 'sequelize';
import OutboxEvent from '@/models/outbox/OutboxEvent.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { mapMysqlClientError } from '@/misc/utils/db/mysqlClientError.js';
import type { OutboxEventType, OutboxPayloadByType } from './events.js';

export class OutboxService {
  static async emit<K extends OutboxEventType>(
    eventType: K,
    args: {
      aggregate: string;
      aggregateId: string;
      payload: OutboxPayloadByType[K];
      dedupKey?: string | null;
      transaction?: Transaction;
    },
  ): Promise<void> {
    try {
      await OutboxEvent.create(
        {
          eventType,
          aggregate: args.aggregate,
          aggregateId: args.aggregateId,
          payload: args.payload as object,
          dedupKey: args.dedupKey ?? null,
          attempts: 0,
        },
        { transaction: args.transaction },
      );
    } catch (err) {
      if (mapMysqlClientError(err)?.code === 'ER_DUP_ENTRY') {
        logger.debug(`[outbox] Dedup skip for ${eventType} ${args.dedupKey ?? ''}`);
        return;
      }
      throw err;
    }
  }
}
