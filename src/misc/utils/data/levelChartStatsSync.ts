import CdnFile from '@/models/cdn/CdnFile.js';
import Level from '@/models/levels/Level.js';
import { getFileIdFromCdnUrl, isCdnUrl } from '@/misc/utils/Utility.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';

const elasticsearchService = ElasticsearchService.getInstance();

type CacheJson = {
  tilecount?: number;
  settings?: { bpm?: number };
  analysis?: { levelLengthInMs?: number };
};

/** Parse CDN level cache JSON for denormalized level columns / ES. */
export function parseChartStatsFromCache(cacheData: string | null): {
  bpm: number | null;
  tilecount: number | null;
  levelLengthInMs: number | null;
} {
  if (!cacheData) return { bpm: null, tilecount: null, levelLengthInMs: null };
  try {
    const parsed = JSON.parse(cacheData) as CacheJson;
    const tilecount =
      typeof parsed.tilecount === 'number' && Number.isFinite(parsed.tilecount)
        ? Math.floor(parsed.tilecount)
        : null;
    const bpmRaw = parsed.settings?.bpm;
    const bpm = typeof bpmRaw === 'number' && Number.isFinite(bpmRaw) ? bpmRaw : null;
    const lenRaw = parsed.analysis?.levelLengthInMs;
    const levelLengthInMs =
      typeof lenRaw === 'number' && Number.isFinite(lenRaw) ? lenRaw : null;
    return { bpm, tilecount, levelLengthInMs };
  } catch {
    return { bpm: null, tilecount: null, levelLengthInMs: null };
  }
}

/**
 * Copy chart BPM, tile count, and level length (ms) from `cdn_files.cacheData` onto the level row, then reindex ES.
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

  const file = await CdnFile.findByPk(fileId, { attributes: ['cacheData'] });
  const { bpm, tilecount, levelLengthInMs } = parseChartStatsFromCache(file?.cacheData ?? null);
  await Level.update({ bpm, tilecount, levelLengthInMs }, { where: { id: levelId }, hooks: false });
  await elasticsearchService.indexLevel(levelId);
}
