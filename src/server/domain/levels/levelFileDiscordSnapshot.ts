import { EMPTY_LEVEL_CHART_STATS } from '@/misc/utils/data/chartCacheParse.js';
import type {
  DiscordLevelChartStatsSnapshot,
  DiscordLevelPreviousSource,
  DiscordLevelZipFilesSnapshot,
} from '@/server/services/outbox/events.js';

export type LevelChartStatsSource = {
  bpm?: number | null;
  tilecount?: number | null;
  midspinCount?: number | null;
  autoTileCount?: number | null;
  levelLengthInMs?: number | null;
};

export type FallbackLevelFile = {
  name?: string;
  relativePath?: string;
};

function posixNorm(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function basename(pathValue: string): string {
  const normalised = posixNorm(pathValue);
  const slash = normalised.lastIndexOf('/');
  return slash >= 0 ? normalised.slice(slash + 1) : normalised;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function unwrapCdnMetadata(raw: unknown): Record<string, unknown> | null {
  const outer = asRecord(raw);
  if (!outer) {
    return null;
  }
  const nested = asRecord(outer.metadata);
  if (nested) {
    return nested;
  }
  return outer;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isGoogleDriveHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'drive.google.com' ||
    host.endsWith('.drive.google.com') ||
    host === 'drive.usercontent.google.com'
  );
}

export function classifyPreviousSource(url: string, isCdn: boolean): DiscordLevelPreviousSource {
  if (isCdn) {
    return 'cdn';
  }
  try {
    if (isGoogleDriveHost(new URL(url).hostname)) {
      return 'google_drive';
    }
  } catch {
    if (url.includes('drive.google.com') || url.includes('drive.usercontent.google.com')) {
      return 'google_drive';
    }
  }
  return 'external';
}

export function previousSourceHostname(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

export function resolveUploadSource(source: unknown): string {
  return typeof source === 'string' && source.trim() ? source.trim() : 'level_edit';
}

export function chartStatsFromLevel(level: LevelChartStatsSource | null | undefined): DiscordLevelChartStatsSnapshot {
  if (!level) {
    return { ...EMPTY_LEVEL_CHART_STATS };
  }
  return {
    bpm: typeof level.bpm === 'number' && Number.isFinite(level.bpm) ? level.bpm : null,
    tilecount:
      typeof level.tilecount === 'number' && Number.isFinite(level.tilecount)
        ? Math.floor(level.tilecount)
        : null,
    midspinCount:
      typeof level.midspinCount === 'number' && Number.isFinite(level.midspinCount)
        ? Math.floor(level.midspinCount)
        : null,
    autoTileCount:
      typeof level.autoTileCount === 'number' && Number.isFinite(level.autoTileCount)
        ? Math.floor(level.autoTileCount)
        : null,
    levelLengthInMs:
      typeof level.levelLengthInMs === 'number' && Number.isFinite(level.levelLengthInMs)
        ? level.levelLengthInMs
        : null,
  };
}

export function oldChartStatsForPreviousSource(
  previousSource: DiscordLevelPreviousSource,
  level: LevelChartStatsSource | null | undefined,
): DiscordLevelChartStatsSnapshot {
  if (previousSource !== 'cdn') {
    return { ...EMPTY_LEVEL_CHART_STATS };
  }
  return chartStatsFromLevel(level);
}

function chartsFromUnknownList(list: unknown): DiscordLevelZipFilesSnapshot['charts'] {
  if (!Array.isArray(list)) {
    return [];
  }
  const charts: DiscordLevelZipFilesSnapshot['charts'] = [];
  for (const item of list) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const relativePath =
      stringField(record.relativePath) || stringField(record.name) || stringField(record.fullPath);
    const name = stringField(record.name) || (relativePath ? basename(relativePath) : null);
    if (!name && !relativePath) {
      continue;
    }
    charts.push({
      name: name || relativePath || 'unknown',
      relativePath: relativePath || name || 'unknown',
    });
  }
  return charts;
}

function audioFromSongFiles(songFiles: unknown): DiscordLevelZipFilesSnapshot['audio'] {
  const record = asRecord(songFiles);
  if (!record) {
    return [];
  }
  const audio: DiscordLevelZipFilesSnapshot['audio'] = [];
  for (const [key, value] of Object.entries(record)) {
    const entry = asRecord(value);
    const name =
      stringField(entry?.name) ||
      stringField(entry?.relativePath) ||
      (key ? basename(key) : null);
    if (!name) {
      continue;
    }
    audio.push({ name });
  }
  return audio;
}

export function extractZipFilesSnapshot(
  metadata: unknown,
  fallbackLevelFiles?: FallbackLevelFile[] | null,
): DiscordLevelZipFilesSnapshot {
  const unwrapped = unwrapCdnMetadata(metadata);
  const chartsFromMeta = chartsFromUnknownList(unwrapped?.allLevelFiles);
  const charts =
    chartsFromMeta.length > 0
      ? chartsFromMeta
      : chartsFromUnknownList(fallbackLevelFiles ?? []);
  charts.sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.name.localeCompare(b.name));

  const audio = audioFromSongFiles(unwrapped?.songFiles);
  audio.sort((a, b) => a.name.localeCompare(b.name));

  return {
    charts,
    audio,
    targetRelativePath: stringField(unwrapped?.targetLevelRelativePath),
  };
}
