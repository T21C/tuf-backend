import { logger } from '@/server/services/core/LoggerService.js';
import { CDC_CHECKPOINT_REDIS_KEY } from './constants.js';

export interface BinlogCheckpoint {
  filename: string;
  position: number;
}

/** Load checkpoint using an explicit Redis client (CDC standalone process). */
export async function loadBinlogCheckpointFrom(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redisClient: any,
): Promise<BinlogCheckpoint | null> {
  try {
    const raw = await redisClient.get(CDC_CHECKPOINT_REDIS_KEY);
    if (!raw || typeof raw !== 'string') return null;
    const parsed = JSON.parse(raw) as BinlogCheckpoint;
    if (!parsed?.filename || typeof parsed.position !== 'number') return null;
    return parsed;
  } catch (e) {
    logger.warn('[cdc] Failed to load binlog checkpoint:', e);
    return null;
  }
}

export async function saveBinlogCheckpointTo(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redisClient: any,
  cp: BinlogCheckpoint,
): Promise<void> {
  try {
    await redisClient.set(CDC_CHECKPOINT_REDIS_KEY, JSON.stringify(cp));
  } catch (e) {
    logger.warn('[cdc] Failed to save binlog checkpoint:', e);
  }
}
