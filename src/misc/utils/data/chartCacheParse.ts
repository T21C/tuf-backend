/**
 * Pure parsing of `cdn_files.cacheData` JSON into denormalized chart fields.
 * Shared by main server sync helpers and CDN routes (no HTTP / DB client dependencies).
 */

type CacheJson = {
  tilecount?: number;
  settings?: { bpm?: number | string };
  analysis?: { levelLengthInMs?: number; autoTileCount?: number };
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

/** Parse CDN level cache JSON for denormalized level columns / ES. */
export function parseChartStatsFromCache(cacheData: string | null): {
  bpm: number | null;
  tilecount: number | null;
  levelLengthInMs: number | null;
  autoTileCount: number | null;
} {
  if (!cacheData) {
    return { bpm: null, tilecount: null, levelLengthInMs: null, autoTileCount: null };
  }
  try {
    const parsed = JSON.parse(cacheData) as CacheJson;
    const tilecount =
      typeof parsed.tilecount === 'number' && Number.isFinite(parsed.tilecount)
        ? Math.floor(parsed.tilecount)
        : null;
    const bpm = parseBpmFromSettings(parsed.settings?.bpm);
    const lenRaw = parsed.analysis?.levelLengthInMs;
    const levelLengthInMs =
      typeof lenRaw === 'number' && Number.isFinite(lenRaw) ? lenRaw : null;
    const autoRaw = parsed.analysis?.autoTileCount;
    const autoTileCount =
      typeof autoRaw === 'number' && Number.isFinite(autoRaw)
        ? Math.floor(autoRaw)
        : null;
    return { bpm, tilecount, levelLengthInMs, autoTileCount };
  } catch {
    return { bpm: null, tilecount: null, levelLengthInMs: null, autoTileCount: null };
  }
}
