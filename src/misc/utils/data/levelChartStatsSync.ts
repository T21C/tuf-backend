import Level from '@/models/levels/Level.js';
import cdnService from '@/server/services/core/CdnService.js';
import { isCdnUrl, isWritableCdnUrl } from '@/misc/utils/Utility.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import { invalidatePackLevelsCachesForLevelIds } from '@/server/services/packs/packDetailCacheService.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { EMPTY_LEVEL_CHART_STATS, type LevelChartStats } from './chartCacheParse.js';
import { syncWrongJudgementFlagsForLevel } from '@/misc/utils/pass/wrongJudgementSync.js';
import { applyMidspinPerfectsDifferenceToLevelPasses } from '@/misc/utils/pass/applyMidspinPerfectsDifference.js';
import { midspinCountOrZero } from '@/misc/utils/pass/midspinPerfectDecrement.js';

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

export { parseChartStatsFromCache } from './chartCacheParse.js';

type StoredChartMatch = {
  tilecount: number | null;
  autoTileCount: number | null;
  midspinCount: number | null;
};

function uniqueIds(ids: number[]): number[] {
  return [...new Set(ids)];
}

/**
 * When midspinCount changes, shift Perfect by (old - new) on legacy passes
 * whose hit total exactly equals the tilecount from before the change.
 * Then refresh wrong-judgement flags against the chart that was just saved.
 */
export async function adjustPassesForMidspinChange(params: {
  levelId: number;
  before: StoredChartMatch;
  nextTilecount: number | null;
  nextAutoTileCount: number | null;
  nextMidspinCount: number | null;
}): Promise<void> {
  const midspinChanged =
    midspinCountOrZero(params.before.midspinCount) !== midspinCountOrZero(params.nextMidspinCount);
  const tilesChanged =
    (params.before.tilecount ?? null) !== (params.nextTilecount ?? null) ||
    (params.before.autoTileCount ?? null) !== (params.nextAutoTileCount ?? null);

  let passIds: number[] = [];
  let playerIds: number[] = [];
  if (midspinChanged) {
    const diff = await applyMidspinPerfectsDifferenceToLevelPasses({
      levelId: params.levelId,
      oldMidspinCount: params.before.midspinCount,
      newMidspinCount: params.nextMidspinCount,
      tilecount: params.before.tilecount,
      autoTileCount: params.before.autoTileCount,
    });
    passIds = diff.passIds;
    playerIds = diff.playerIds;
  }

  if (!tilesChanged && passIds.length === 0) return;

  const flagPassIds = await syncWrongJudgementFlagsForLevel({
    levelId: params.levelId,
    tilecount: params.nextTilecount,
    autoTileCount: params.nextAutoTileCount,
  });
  const reindexIds = uniqueIds([...passIds, ...flagPassIds]);
  if (reindexIds.length > 0) {
    await elasticsearchService.reindexPasses(reindexIds);
  }
  if (playerIds.length > 0) {
    await elasticsearchService.reindexPlayers(uniqueIds(playerIds));
  }
}

async function saveChartStats(
  levelId: number,
  before: StoredChartMatch,
  next: LevelChartStats,
): Promise<void> {
  await Level.update(
    {
      bpm: next.bpm,
      tilecount: next.tilecount,
      levelLengthInMs: next.levelLengthInMs,
      autoTileCount: next.autoTileCount,
      midspinCount: next.midspinCount,
    },
    { where: { id: levelId }, hooks: false },
  );
  await adjustPassesForMidspinChange({
    levelId,
    before,
    nextTilecount: next.tilecount ?? null,
    nextAutoTileCount: next.autoTileCount ?? null,
    nextMidspinCount: next.midspinCount ?? null,
  });
  await elasticsearchService.indexLevel(levelId);
  await invalidateLevelCaches(levelId);
}

/**
 * Copy chart BPM, tile count, and level length (ms) from CDN chart cache via microservice, onto the level row, then reindex ES.
 * Call after commits when CDN zip / target / dlLink may have changed (cross-pool; do not pass a transaction).
 */
function chartBefore(level: {
  tilecount?: number | null;
  autoTileCount?: number | null;
  midspinCount?: number | null;
}): StoredChartMatch {
  return {
    tilecount: level.tilecount ?? null,
    autoTileCount: level.autoTileCount ?? null,
    midspinCount: level.midspinCount ?? null,
  };
}

export async function applyLevelChartStatsFromCdn(levelId: number): Promise<void> {
  const level = await Level.findByPk(levelId, {
    attributes: ['id', 'dlLink', 'fileId', 'tilecount', 'autoTileCount', 'midspinCount'],
  });
  if (!level) return;

  const before = chartBefore(level);
  const fileId = level.fileId ?? null;
  if (!level.dlLink || !isCdnUrl(level.dlLink) || !fileId) {
    await saveChartStats(levelId, before, { ...EMPTY_LEVEL_CHART_STATS });
    return;
  }

  if (!isWritableCdnUrl(level.dlLink)) {
    return;
  }

  const next = await cdnService.getLevelChartStats(fileId);
  await saveChartStats(levelId, before, next);
}

/**
 * Rebuild CDN zip analysis cache, then copy denormalized chart fields onto the level row and reindex ES.
 * Falls back to reading the existing cache if refresh fails.
 */
export async function rebuildCdnCacheAndApplyLevelChartStats(levelId: number): Promise<LevelChartStats | null> {
  const level = await Level.findByPk(levelId, {
    attributes: ['id', 'dlLink', 'fileId', 'tilecount', 'autoTileCount', 'midspinCount'],
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

  let next: LevelChartStats;
  try {
    next = await cdnService.refreshLevelChartCacheAndGetStats(fileId);
  } catch (error) {
    logger.warn(`CDN chart cache refresh failed for level ${levelId}; falling back to existing cache`, {
      error: error instanceof Error ? error.message : String(error),
    });
    await applyLevelChartStatsFromCdn(levelId);
    return null;
  }

  await saveChartStats(levelId, chartBefore(level), next);
  return next;
}
