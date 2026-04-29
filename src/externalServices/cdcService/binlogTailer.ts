import ZongJi from '@vlasky/zongji';
import type {
  AnyBinlogEvent,
  RotateEvent,
  WriteRowsEvent,
  UpdateRowsEvent,
  DeleteRowsEvent,
} from '@vlasky/zongji';
import { createClient as redisCreateClient } from 'redis';
import { logger } from '@/server/services/core/LoggerService.js';
import { CDC_WATCHED_TABLES } from './constants.js';
import { loadBinlogCheckpointFrom, saveBinlogCheckpointTo } from './binlogCheckpoint.js';
import { isCdcIngestPaused } from './cdcRestoreCoordination.js';
import { publishCdcRow } from './publisher.js';
import type { CdcOp } from '@/server/services/eventBus/types.js';

// Aliased to `any` to prevent the deep `redis` client generics from being
// instantiated across this file. See server/src/server/services/core/RedisService.ts
// for the same pattern; instantiating RedisClientType here was a major
// contributor to the tsc check phase blowing past the heap limit.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createClient: any = redisCreateClient;

export interface StartBinlogTailerOptions {
  /** Unique MySQL replication server_id for this CDC client (must not collide with primary or replicas). */
  serverId: number;
  redisUrl: string;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30 * 60 * 1_000;

function buildIncludeSchema(dbName: string): Record<string, string[] | true> {
  return {
    [dbName]: [...CDC_WATCHED_TABLES],
  };
}

function attachBinlogHandler(
  zongji: ZongJi,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redisClient: any,
  binlogState: { currentFile: string },
): void {
  zongji.on('binlog', async (evt: AnyBinlogEvent) => {
    try {
      logger.debug('[cdc] binlog event:', evt.getEventName());
      const eventName = evt.getEventName();
      switch (eventName) {
        case 'rotate': {
          const e = evt as RotateEvent;
          binlogState.currentFile = e.binlogName;
          await saveBinlogCheckpointTo(redisClient, {
            filename: binlogState.currentFile,
            position: e.position,
          });
          break;
        }
        case 'writerows': {
          const e = evt as WriteRowsEvent;
          const binlogFilename = binlogState.currentFile || 'unknown';
          const binlogPosition = e.nextPosition;
          const map = e.tableMap[e.tableId];
          if (!map) break;
          const table = map.tableName;
          const schema = map.parentSchema;
          const ingestPaused = await isCdcIngestPaused(redisClient);
          if (!ingestPaused) {
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
          }
          await saveBinlogCheckpointTo(redisClient, {
            filename: binlogFilename,
            position: binlogPosition,
          });
          break;
        }
        case 'updaterows': {
          const e = evt as UpdateRowsEvent;
          const binlogFilename = binlogState.currentFile || 'unknown';
          const binlogPosition = e.nextPosition;
          const map = e.tableMap[e.tableId];
          if (!map) break;
          const table = map.tableName;
          const schema = map.parentSchema;
          const ingestPaused = await isCdcIngestPaused(redisClient);
          if (!ingestPaused) {
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
          }
          await saveBinlogCheckpointTo(redisClient, {
            filename: binlogFilename,
            position: binlogPosition,
          });
          break;
        }
        case 'deleterows': {
          const e = evt as DeleteRowsEvent;
          const binlogFilename = binlogState.currentFile || 'unknown';
          const binlogPosition = e.nextPosition;
          const map = e.tableMap[e.tableId];
          if (!map) break;
          const table = map.tableName;
          const schema = map.parentSchema;
          const ingestPaused = await isCdcIngestPaused(redisClient);
          if (!ingestPaused) {
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
}

export async function startBinlogTailer(options: StartBinlogTailerOptions): Promise<() => Promise<void>> {
  const dbName = process.env.DB_DATABASE ?? '';
  if (!dbName) {
    throw new Error('DB_DATABASE is required for CDC');
  }

  const includeSchema = buildIncludeSchema(dbName);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const redisClient: any = createClient({ url: options.redisUrl });
  redisClient.on('error', (err: Error) => logger.error('[cdc] Redis client error:', err));
  await redisClient.connect();

  const zongjiConn = {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    user: process.env.CDC_DB_USER || process.env.DB_USER,
    password: process.env.CDC_DB_PASSWORD || process.env.DB_PASSWORD,
    database: dbName,
    ssl: process.env.DB_SSL === 'true' ? {} : undefined,
  };

  let stopped = false;
  let currentZongji: ZongJi | null = null;
  let wakeSleep: (() => void) | null = null;
  /** Resolves the in-session wait when ZongJi errors or `stop()` runs. */
  let endActiveSession: (() => void) | null = null;

  const loopPromise = (async () => {
    let postFailureDelayMs = 0;

    while (!stopped) {
      if (postFailureDelayMs > 0) {
        logger.info(`[cdc] reconnecting in ${Math.round(postFailureDelayMs / 1000)}s (${postFailureDelayMs}ms)`);
        await new Promise<void>((resolve) => {
          if (stopped) {
            resolve();
            return;
          }
          const id = setTimeout(() => {
            wakeSleep = null;
            resolve();
          }, postFailureDelayMs);
          wakeSleep = () => {
            clearTimeout(id);
            wakeSleep = null;
            resolve();
          };
        });
      }

      if (stopped) break;

      const checkpoint = await loadBinlogCheckpointFrom(redisClient);
      const binlogState = { currentFile: checkpoint?.filename ?? '' };

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

      let zongji: ZongJi | null = null;
      try {
        zongji = new ZongJi(zongjiConn);
        currentZongji = zongji;
        attachBinlogHandler(zongji, redisClient, binlogState);

        const sessionEnded = new Promise<void>((resolve) => {
          endActiveSession = () => {
            endActiveSession = null;
            resolve();
          };
          zongji!.once('error', (err: Error) => {
            if (!stopped) {
              logger.error('[cdc] ZongJi error:', err);
            }
            endActiveSession?.();
          });
        });

        zongji.start(startOpts);
        postFailureDelayMs = 0;
        logger.info('[cdc] ZongJi binlog tailer connected');

        await sessionEnded;
      } catch (err) {
        if (!stopped) {
          logger.error('[cdc] ZongJi start/session error:', err);
        }
      } finally {
        endActiveSession = null;
        if (zongji) {
          try {
            zongji.removeAllListeners();
            zongji.stop();
          } catch (e) {
            logger.warn('[cdc] zongji.stop failed:', e);
          }
        }
        if (currentZongji === zongji) {
          currentZongji = null;
        }
      }

      if (stopped) break;

      postFailureDelayMs =
        postFailureDelayMs === 0 ? INITIAL_BACKOFF_MS : Math.min(MAX_BACKOFF_MS, postFailureDelayMs * 2);
    }
  })();

  return async () => {
    stopped = true;
    wakeSleep?.();
    endActiveSession?.();
    try {
      currentZongji?.removeAllListeners();
      currentZongji?.stop();
    } catch (e) {
      logger.warn('[cdc] zongji.stop on shutdown failed:', e);
    }
    currentZongji = null;
    await loopPromise.catch((e) => logger.warn('[cdc] reconnect loop exit:', e));
    try {
      await redisClient.quit();
    } catch (e) {
      logger.warn('[cdc] redis quit failed:', e);
    }
  };
}
