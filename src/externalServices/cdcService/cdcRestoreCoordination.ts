import {
  CDC_WATCHED_TABLES,
  CDC_STREAM_PREFIX,
  CDC_CHECKPOINT_REDIS_KEY,
  CDC_INGEST_PAUSED_KEY,
} from './constants.js';
import { logger } from '@/server/services/core/LoggerService.js';

const PAUSED_MARK = '1';

/** True when backup restore (or ops) has paused CDC stream ingest. */
export async function isCdcIngestPaused(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
): Promise<boolean> {
  try {
    const v = await client.get(CDC_INGEST_PAUSED_KEY);
    return v === PAUSED_MARK;
  } catch {
    return false;
  }
}

export async function setCdcIngestPaused(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  paused: boolean,
): Promise<void> {
  if (paused) {
    await client.set(CDC_INGEST_PAUSED_KEY, PAUSED_MARK);
    logger.info('[cdc-restore] CDC ingest paused (binlog tailer will not XADD)');
  } else {
    await client.del(CDC_INGEST_PAUSED_KEY);
    logger.info('[cdc-restore] CDC ingest resumed');
  }
}

/** Remove CDC stream keys and DLQs so projectors start from an empty backlog after restore. */
export async function resetCdcStreams(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
): Promise<void> {
  const keys: string[] = [];
  for (const table of CDC_WATCHED_TABLES) {
    keys.push(`${CDC_STREAM_PREFIX}${table}`, `${CDC_STREAM_PREFIX}${table}:dlq`);
  }
  if (keys.length === 0) return;
  await client.del(keys);
  logger.info(`[cdc-restore] Deleted ${keys.length} CDC stream / DLQ keys`);
}

export async function clearCdcBinlogCheckpoint(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
): Promise<void> {
  await client.del(CDC_CHECKPOINT_REDIS_KEY);
  logger.info('[cdc-restore] Cleared CDC binlog checkpoint (next tailer session may use startAtEnd)');
}
