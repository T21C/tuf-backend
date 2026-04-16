import Level from '@/models/levels/Level.js';
import cdnService from '@/server/services/core/CdnService.js';
import { isCdnUrl } from '@/misc/utils/Utility.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import { logger } from '@/server/services/core/LoggerService.js';

const elasticsearchService = ElasticsearchService.getInstance();

/** Same tags as `invalidateLevelCache` in models/levels/hooks.ts (skipped when update uses hooks: false). */
async function invalidateLevelHttpCache(levelId: number): Promise<void> {
  try {
    await CacheInvalidation.invalidateTags([`level:${levelId}`, 'levels:all']);
  } catch (error) {
    logger.error(`Cache invalidation after chart stats sync failed for level ${levelId}:`, error);
  }
}

export { parseChartStatsFromCache } from './chartCacheParse.js';

/**
 * Copy chart BPM, tile count, and level length (ms) from CDN chart cache via microservice, onto the level row, then reindex ES.
 * Call after commits when CDN zip / target / dlLink may have changed (cross-pool; do not pass a transaction).
 */
export async function applyLevelChartStatsFromCdn(levelId: number): Promise<void> {
  const level = await Level.findByPk(levelId, { attributes: ['id', 'dlLink', 'fileId'] });
  if (!level) return;

  const fileId = level.fileId ?? null;
  if (!level.dlLink || !isCdnUrl(level.dlLink) || !fileId) {
    await Level.update(
      { bpm: null, tilecount: null, levelLengthInMs: null },
      { where: { id: levelId }, hooks: false },
    );
    await elasticsearchService.indexLevel(levelId);
    await invalidateLevelHttpCache(levelId);
    return;
  }

  const { bpm, tilecount, levelLengthInMs } = await cdnService.getLevelChartStats(fileId);
  await Level.update({ bpm, tilecount, levelLengthInMs }, { where: { id: levelId }, hooks: false });
  await elasticsearchService.indexLevel(levelId);
  await invalidateLevelHttpCache(levelId);
}
