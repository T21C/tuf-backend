import Level from '@/models/levels/Level.js';
import cdnService from '@/server/services/core/CdnService.js';
import { isCdnUrl, isWritableCdnUrl } from '@/misc/utils/Utility.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import { invalidatePackLevelsCachesForLevelIds } from '@/server/services/packs/packDetailCacheService.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { EMPTY_LEVEL_CHART_STATS, type LevelChartStats } from './chartCacheParse.js';
import { syncWrongJudgementFlagsForLevel } from '@/misc/utils/pass/wrongJudgementSync.js';

const elasticsearchService = ElasticsearchService.getInstance();

/**
 * Clear all Redis caches that embed level data. Mirrors `invalidateLevel` in the CDC projector
 * (startCdcProjectors.ts) so callers that update level rows with `hooks: false` — or that rebuild
 * analysis without changing any persisted column (no binlog row event) — never leave stale entries.
 * Always invoke this directly instead of relying on CDC to pick the change up.
 */
export async function invalidateLevelCaches(levelId: number): Promise<void> {
  try {
    await CacheInvalidation.invalidateTags([`level:${levelId}`, 'levels:all']);
    await invalidatePackLevelsCachesForLevelIds([levelId]);
  } catch (error) {
    logger.error(`Cache invalidation after chart stats sync failed for level ${levelId}:`, error);
  }
}

async function reindexWrongJudgementFlags(
  levelId: number,
  tilecount: unknown,
  autoTileCount: unknown,
): Promise<void> {
  const flagPassIds = await syncWrongJudgementFlagsForLevel({
    levelId,
    tilecount,
    autoTileCount,
  });
  if (flagPassIds.length > 0) {
    await elasticsearchService.reindexPasses(flagPassIds);
  }
}

export { parseChartStatsFromCache } from './chartCacheParse.js';

/**
 * Copy chart BPM, tile count, and level length (ms) from CDN chart cache via microservice, onto the level row, then reindex ES.
 * Call after commits when CDN zip / target / dlLink may have changed (cross-pool; do not pass a transaction).
 */
export async function applyLevelChartStatsFromCdn(levelId: number): Promise<void> {
  const level = await Level.findByPk(levelId, {
    attributes: ['id', 'dlLink', 'fileId', 'tilecount', 'autoTileCount'],
  });
  if (!level) return;

  const fileId = level.fileId ?? null;
  if (!level.dlLink || !isCdnUrl(level.dlLink) || !fileId) {
    const hadChart =
      level.tilecount != null || level.autoTileCount != null;
    await Level.update(
      { bpm: null, tilecount: null, levelLengthInMs: null, autoTileCount: null, midspinCount: null },
      { where: { id: levelId }, hooks: false },
    );
    if (hadChart) {
      await reindexWrongJudgementFlags(levelId, null, null);
    }
    await elasticsearchService.indexLevel(levelId);
    await invalidateLevelCaches(levelId);
    return;
  }

  if (!isWritableCdnUrl(level.dlLink)) {
    return;
  }

  const { bpm, tilecount, levelLengthInMs, autoTileCount, midspinCount } = await cdnService.getLevelChartStats(fileId);
  const chartChanged =
    (level.tilecount ?? null) !== (tilecount ?? null) ||
    (level.autoTileCount ?? null) !== (autoTileCount ?? null);
  await Level.update(
    { bpm, tilecount, levelLengthInMs, autoTileCount, midspinCount },
    { where: { id: levelId }, hooks: false },
  );
  if (chartChanged) {
    await reindexWrongJudgementFlags(levelId, tilecount, autoTileCount);
  }
  await elasticsearchService.indexLevel(levelId);
  await invalidateLevelCaches(levelId);
}

/**
 * Rebuild CDN zip analysis cache, then copy denormalized chart fields onto the level row and reindex ES.
 * Falls back to reading the existing cache if refresh fails.
 */
export async function rebuildCdnCacheAndApplyLevelChartStats(levelId: number): Promise<LevelChartStats | null> {
  const level = await Level.findByPk(levelId, {
    attributes: ['id', 'dlLink', 'fileId', 'tilecount', 'autoTileCount'],
  });
  if (!level) {
    return null;
  }

  if (!level.dlLink || !isCdnUrl(level.dlLink)) {
    await applyLevelChartStatsFromCdn(levelId);
    return { ...EMPTY_LEVEL_CHART_STATS };
  }

  if (!isWritableCdnUrl(level.dlLink)) {
    return { ...EMPTY_LEVEL_CHART_STATS };
  }

  const fileId = level.fileId ?? null;
  if (!fileId) {
    await applyLevelChartStatsFromCdn(levelId);
    return { ...EMPTY_LEVEL_CHART_STATS };
  }

  try {
    const { bpm, tilecount, levelLengthInMs, autoTileCount, midspinCount } =
      await cdnService.refreshLevelChartCacheAndGetStats(fileId);
    const chartChanged =
      (level.tilecount ?? null) !== (tilecount ?? null) ||
      (level.autoTileCount ?? null) !== (autoTileCount ?? null);
    await Level.update(
      { bpm, tilecount, levelLengthInMs, autoTileCount, midspinCount },
      { where: { id: levelId }, hooks: false },
    );
    if (chartChanged) {
      await reindexWrongJudgementFlags(levelId, tilecount, autoTileCount);
    }
    await elasticsearchService.indexLevel(levelId);
    await invalidateLevelCaches(levelId);
    return { bpm, tilecount, levelLengthInMs, autoTileCount, midspinCount };
  } catch (error) {
    logger.warn(`CDN chart cache refresh failed for level ${levelId}; falling back to existing cache`, {
      error: error instanceof Error ? error.message : String(error),
    });
    await applyLevelChartStatsFromCdn(levelId);
    return null;
  }
}
