import Level from '@/models/levels/Level.js';
import cdnService from '@/server/services/core/CdnService.js';
import { getFileIdFromCdnUrl, isCdnUrl } from '@/misc/utils/Utility.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';

const elasticsearchService = ElasticsearchService.getInstance();

export { parseChartStatsFromCache } from './chartCacheParse.js';

/**
 * Copy chart BPM, tile count, and level length (ms) from CDN chart cache via microservice, onto the level row, then reindex ES.
 * Call after commits when CDN zip / target / dlLink may have changed (cross-pool; do not pass a transaction).
 */
export async function applyLevelChartStatsFromCdn(levelId: number): Promise<void> {
  const level = await Level.findByPk(levelId, { attributes: ['id', 'dlLink'] });
  if (!level) return;

  if (!level.dlLink || !isCdnUrl(level.dlLink)) {
    await Level.update(
      { bpm: null, tilecount: null, levelLengthInMs: null },
      { where: { id: levelId }, hooks: false },
    );
    await elasticsearchService.indexLevel(levelId);
    return;
  }

  const fileId = getFileIdFromCdnUrl(level.dlLink);
  if (!fileId) {
    await Level.update(
      { bpm: null, tilecount: null, levelLengthInMs: null },
      { where: { id: levelId }, hooks: false },
    );
    await elasticsearchService.indexLevel(levelId);
    return;
  }

  const { bpm, tilecount, levelLengthInMs } = await cdnService.getLevelChartStats(fileId);
  await Level.update({ bpm, tilecount, levelLengthInMs }, { where: { id: levelId }, hooks: false });
  await elasticsearchService.indexLevel(levelId);
}

/**
 * Ask CDN service to clear/rebuild zip cache for current metadata, then copy chart fields onto the level row.
 * Use after target-level changes or when stats are stale.
 */
export async function rebuildCdnCacheAndApplyLevelChartStats(levelId: number): Promise<void> {
  const level = await Level.findByPk(levelId, { attributes: ['id', 'dlLink'] });
  if (!level) {
    return;
  }

  if (!level.dlLink || !isCdnUrl(level.dlLink)) {
    await applyLevelChartStatsFromCdn(levelId);
    return;
  }

  const fileId = getFileIdFromCdnUrl(level.dlLink);
  if (!fileId) {
    await applyLevelChartStatsFromCdn(levelId);
    return;
  }

  try {
    const { bpm, tilecount, levelLengthInMs } = await cdnService.refreshLevelChartCacheAndGetStats(fileId);
    await Level.update({ bpm, tilecount, levelLengthInMs }, { where: { id: levelId }, hooks: false });
    await elasticsearchService.indexLevel(levelId);
  } catch {
    await applyLevelChartStatsFromCdn(levelId);
  }
}
