import { createClient } from 'redis';
import sequelize from '@/config/db.js';
import { QueryTypes } from 'sequelize';
import { logger } from '@/server/services/core/LoggerService.js';
import { saveBinlogCheckpointTo } from './binlogCheckpoint.js';
import { resetCdcStreams } from './cdcRestoreCoordination.js';

interface MasterStatusRow {
  File: string;
  Position: number;
}

/**
 * Sets the CDC binlog checkpoint to the current primary binlog coordinates and optionally
 * clears CDC Redis streams (drops backlog that would replay mass migrations).
 */
export async function advanceCdcBinlogCheckpointToCurrent(options?: {
  resetStreams?: boolean;
  redisUrl?: string;
}): Promise<{ filename: string; position: number } | null> {
  const redisUrl = options?.redisUrl ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
  const client = createClient({ url: redisUrl });
  client.on('error', (err) => logger.error('[cdc] Redis client error (advance checkpoint):', err));
  await client.connect();

  try {
    const rows = (await sequelize.query('SHOW MASTER STATUS', {
      type: QueryTypes.SELECT,
    })) as MasterStatusRow[];
    const row = rows[0];
    if (!row?.File || row.Position == null) {
      logger.warn('[cdc] SHOW MASTER STATUS returned no coordinates');
      return null;
    }

    const checkpoint = { filename: String(row.File), position: Number(row.Position) };
    await saveBinlogCheckpointTo(client, checkpoint);

    if (options?.resetStreams !== false) {
      await resetCdcStreams(client);
    }

    logger.info(`[cdc] Advanced binlog checkpoint to ${checkpoint.filename}:${checkpoint.position}`);
    return checkpoint;
  } finally {
    await client.quit().catch(() => {});
  }
}
