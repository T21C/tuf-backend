/**
 * Pure parsing of `cdn_files.cacheData` JSON into denormalized chart fields.
 * Shared by main server sync helpers and CDN routes (no HTTP / DB client dependencies).
 */

export type LevelChartStats = {
  bpm: number | null;
  /** In-game tilecount: path length minus midspins. */
  tilecount: number | null;
  levelLengthInMs: number | null;
  autoTileCount: number | null;
  midspinCount: number | null;
};

type CacheJson = {
  tilecount?: number;
  settings?: { bpm?: number | string };
  analysis?: { levelLengthInMs?: number; autoTileCount?: number; midspinCount?: number };
};

export const EMPTY_LEVEL_CHART_STATS: LevelChartStats = {
  bpm: null,
  tilecount: null,
  levelLengthInMs: null,
  autoTileCount: null,
  midspinCount: null,
};

function parseBpmFromSettings(bpmRaw: unknown): number | null {
  if (typeof bpmRaw === 'number' && Number.isFinite(bpmRaw)) {
    return bpmRaw;
  }
  if (typeof bpmRaw === 'string') {
    const n = parseFloat(bpmRaw.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseFloorInt(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : null;
}

/** Parse CDN level cache JSON for denormalized level columns / ES. */
export function parseChartStatsFromCache(cacheData: string | null): LevelChartStats {
  if (!cacheData) {
    return { ...EMPTY_LEVEL_CHART_STATS };
  }
  try {
    const parsed = JSON.parse(cacheData) as CacheJson;
    const tilecount = parseFloorInt(parsed.tilecount);
    const bpm = parseBpmFromSettings(parsed.settings?.bpm);
    const lenRaw = parsed.analysis?.levelLengthInMs;
    const levelLengthInMs =
      typeof lenRaw === 'number' && Number.isFinite(lenRaw) ? lenRaw : null;
    return {
      bpm,
      tilecount,
      levelLengthInMs,
      autoTileCount: parseFloorInt(parsed.analysis?.autoTileCount),
      midspinCount: parseFloorInt(parsed.analysis?.midspinCount),
    };
  } catch {
    return { ...EMPTY_LEVEL_CHART_STATS };
  }
}
