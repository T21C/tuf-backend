import ZongJi from '@vlasky/zongji';
import type {
  AnyBinlogEvent,
  RotateEvent,
  WriteRowsEvent,
  UpdateRowsEvent,
  DeleteRowsEvent,
} from '@vlasky/zongji';
import { createClient, type RedisClientType } from 'redis';
import { logger } from '@/server/services/core/LoggerService.js';
import { CDC_WATCHED_TABLES } from './constants.js';
import { loadBinlogCheckpointFrom, saveBinlogCheckpointTo } from './binlogCheckpoint.js';
import { publishCdcRow } from './publisher.js';
import type { CdcOp } from '@/server/services/eventBus/types.js';

export interface StartBinlogTailerOptions {
  /** Unique MySQL replication server_id for this CDC client (must not collide with primary or replicas). */
  serverId: number;
  redisUrl: string;
}

export async function startBinlogTailer(options: StartBinlogTailerOptions): Promise<() => Promise<void>> {
  const dbName = process.env.DB_DATABASE ?? '';
  if (!dbName) {
    throw new Error('DB_DATABASE is required for CDC');
  }

  const includeSchema: Record<string, string[] | true> = {
    [dbName]: [...CDC_WATCHED_TABLES],
  };

  const redisClient: RedisClientType = createClient({ url: options.redisUrl });
  redisClient.on('error', (err) => logger.error('[cdc] Redis client error:', err));
  await redisClient.connect();

  const checkpoint = await loadBinlogCheckpointFrom(redisClient);

  let currentBinlogFile = checkpoint?.filename ?? '';

  const zongji = new ZongJi({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    user: process.env.CDC_DB_USER || process.env.DB_USER,
    password: process.env.CDC_DB_PASSWORD || process.env.DB_PASSWORD,
    database: dbName,
    ssl: process.env.DB_SSL === 'true' ? {} : undefined,
  });

  const startOpts: Parameters<ZongJi['start']>[0] = {
    serverId: options.serverId,
    includeEvents: ['tablemap', 'writerows', 'updaterows', 'deleterows', 'rotate'],
    includeSchema,
  };

  if (checkpoint?.filename && typeof checkpoint.position === 'number') {
    startOpts.filename = checkpoint.filename;
    startOpts.position = checkpoint.position;
    logger.info(`[cdc] Resuming binlog from ${checkpoint.filename}:${checkpoint.position}`);
  } else {
    startOpts.startAtEnd = true;
    logger.info('[cdc] No checkpoint; starting at end of binlog (startAtEnd)');
  }

  zongji.on('binlog', async (evt: AnyBinlogEvent) => {
    try {
      logger.debug('[cdc] binlog event:', evt.getEventName());
      const eventName = evt.getEventName();
      switch (eventName) {
        case 'rotate': {
          const e = evt as RotateEvent;
          currentBinlogFile = e.binlogName;
          await saveBinlogCheckpointTo(redisClient, {
            filename: currentBinlogFile,
            position: e.position,
          });
          break;
        }
        case 'writerows': {
          const e = evt as WriteRowsEvent;
          const binlogFilename = currentBinlogFile || 'unknown';
          const binlogPosition = e.nextPosition;
          const map = e.tableMap[e.tableId];
          if (!map) break;
          const table = map.tableName;
          const schema = map.parentSchema;
          for (const row of e.rows) {
            await publishCdcRow({
              client: redisClient,
              table,
              schema,
              op: 'c' as CdcOp,
              before: null,
              after: row as Record<string, unknown>,
              binlogFilename,
              binlogPosition,
            });
          }
          await saveBinlogCheckpointTo(redisClient, {
            filename: binlogFilename,
            position: binlogPosition,
          });
          break;
        }
        case 'updaterows': {
          const e = evt as UpdateRowsEvent;
          const binlogFilename = currentBinlogFile || 'unknown';
          const binlogPosition = e.nextPosition;
          const map = e.tableMap[e.tableId];
          if (!map) break;
          const table = map.tableName;
          const schema = map.parentSchema;
          for (const pair of e.rows) {
            await publishCdcRow({
              client: redisClient,
              table,
              schema,
              op: 'u' as CdcOp,
              before: pair.before as Record<string, unknown>,
              after: pair.after as Record<string, unknown>,
              binlogFilename,
              binlogPosition,
            });
          }
          await saveBinlogCheckpointTo(redisClient, {
            filename: binlogFilename,
            position: binlogPosition,
          });
          break;
        }
        case 'deleterows': {
          const e = evt as DeleteRowsEvent;
          const binlogFilename = currentBinlogFile || 'unknown';
          const binlogPosition = e.nextPosition;
          const map = e.tableMap[e.tableId];
          if (!map) break;
          const table = map.tableName;
          const schema = map.parentSchema;
          for (const row of e.rows) {
            await publishCdcRow({
              client: redisClient,
              table,
              schema,
              op: 'd' as CdcOp,
              before: row as Record<string, unknown>,
              after: null,
              binlogFilename,
              binlogPosition,
            });
          }
          await saveBinlogCheckpointTo(redisClient, {
            filename: binlogFilename,
            position: binlogPosition,
          });
          break;
        }
        default:
          break;
      }
    } catch (err) {
      logger.error('[cdc] binlog handler error:', err);
    }
  });

  zongji.on('error', (err: Error) => {
    logger.error('[cdc] ZongJi error:', err);
  });

  zongji.start(startOpts);
  logger.info('[cdc] ZongJi binlog tailer started');

  return async () => {
    try {
      zongji.stop();
    } catch (e) {
      logger.warn('[cdc] zongji.stop failed:', e);
    }
    try {
      await redisClient.quit();
    } catch (e) {
      logger.warn('[cdc] redis quit failed:', e);
    }
  };
}
