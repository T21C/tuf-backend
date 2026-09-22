import type MessageBuilder from '@/misc/webhook/classes/messageBuilder.js';
import { previousSourceHostname } from '@/server/domain/levels/levelFileDiscordSnapshot.js';
import type {
  DiscordLevelChartStatsSnapshot,
  DiscordLevelFileSnapshot,
  DiscordLevelPreviousSource,
  DiscordLevelZipFilesSnapshot,
} from '@/server/services/outbox/events.js';

export const DISCORD_FIELD_VALUE_MAX = 1024;

const UPLOAD_SOURCE_LABELS: Record<string, string> = {
  level_edit: 'Level editor',
  upload_from_url: 'URL import',
  mojibake_metadata_migrate: 'Mojibake migration',
};

const CHART_STAT_FIELDS: Array<{
  key: keyof DiscordLevelChartStatsSnapshot;
  label: string;
  format: (value: number) => string;
}> = [
  { key: 'bpm', label: 'BPM', format: formatStatNumber },
  { key: 'tilecount', label: 'Tiles', format: formatStatNumber },
  { key: 'midspinCount', label: 'Midspins', format: formatStatNumber },
  { key: 'autoTileCount', label: 'Auto tiles', format: formatStatNumber },
  { key: 'levelLengthInMs', label: 'Length', format: formatLengthMs },
];

export function clipDiscordFieldValue(value: string): string {
  if (value.length <= DISCORD_FIELD_VALUE_MAX) {
    return value;
  }
  return `${value.slice(0, DISCORD_FIELD_VALUE_MAX - 1)}…`;
}

function formatStatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}

export function formatLengthMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = seconds.toString().padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

export function formatZipSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${Math.round(bytes)} B`;
}

export function formatUploadSource(source: string): string {
  return UPLOAD_SOURCE_LABELS[source] || source;
}

function uuidFromUrl(url: string): string | null {
  const matches = [...url.matchAll(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi)];
  return matches.length === 1 ? matches[0][1] : null;
}

export function formatPreviousSourceField(
  previousSource: DiscordLevelPreviousSource,
  originalPath: string,
): string {
  let label = 'External';
  if (previousSource === 'google_drive') {
    label = 'Google Drive';
  } else if (previousSource === 'cdn') {
    const fileId = uuidFromUrl(originalPath);
    label = fileId ? `CDN · ${fileId}` : 'CDN';
  } else {
    const host = previousSourceHostname(originalPath);
    label = host ? `External (${host})` : 'External';
  }
  return clipDiscordFieldValue(`${label}\n${originalPath}`);
}

function formatStatValue(
  key: keyof DiscordLevelChartStatsSnapshot,
  value: number | null,
  format: (value: number) => string,
): string {
  if (value == null || !Number.isFinite(value)) {
    return '—';
  }
  if (key === 'levelLengthInMs') {
    return formatLengthMs(value);
  }
  return format(value);
}

function statsAreAllNull(stats: DiscordLevelChartStatsSnapshot | undefined): boolean {
  if (!stats) {
    return true;
  }
  return CHART_STAT_FIELDS.every(({ key }) => stats[key] == null);
}

export function formatChartStatsDiff(
  oldStats: DiscordLevelChartStatsSnapshot | undefined,
  newStats: DiscordLevelChartStatsSnapshot | undefined,
): string | null {
  if (!newStats && !oldStats) {
    return null;
  }
  const lines: string[] = [];
  for (const { key, label, format } of CHART_STAT_FIELDS) {
    const oldValue = oldStats?.[key] ?? null;
    const newValue = newStats?.[key] ?? null;
    if (oldValue === newValue) {
      continue;
    }
    lines.push(
      `${label}: ${formatStatValue(key, oldValue, format)} → ${formatStatValue(key, newValue, format)}`,
    );
  }
  if (lines.length === 0) {
    return 'Unchanged';
  }
  return clipDiscordFieldValue(lines.join('\n'));
}

export function formatChartStatsNew(
  newStats: DiscordLevelChartStatsSnapshot | undefined,
): string | null {
  if (!newStats || statsAreAllNull(newStats)) {
    return null;
  }
  const lines: string[] = [];
  for (const { key, label, format } of CHART_STAT_FIELDS) {
    const value = newStats[key];
    if (value == null || !Number.isFinite(value)) {
      continue;
    }
    lines.push(`${label}: ${formatStatValue(key, value, format)}`);
  }
  if (lines.length === 0) {
    return null;
  }
  return clipDiscordFieldValue(lines.join('\n'));
}

function firstFolder(relativePath: string): string {
  const normalised = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const slash = normalised.indexOf('/');
  return slash >= 0 ? normalised.slice(0, slash) : '';
}

function isTargetPath(pathValue: string, targetRelativePath: string | null): boolean {
  if (!targetRelativePath) {
    return false;
  }
  const left = pathValue.replace(/\\/g, '/').replace(/^\/+/, '');
  const right = targetRelativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return left === right;
}

export function formatZipFilesField(files: DiscordLevelZipFilesSnapshot): string {
  const chartCount = files.charts.length;
  const audioCount = files.audio.length;
  const header = `${chartCount} chart${chartCount === 1 ? '' : 's'} · ${audioCount} audio`;
  const lines = [header];
  if (files.targetRelativePath) {
    lines.push(`Target: ${files.targetRelativePath}`);
  }

  const currentText = () => lines.join('\n');
  const remaining = () => DISCORD_FIELD_VALUE_MAX - currentText().length;

  const chartLines = files.charts.map((chart) => {
    const pathValue = chart.relativePath || chart.name;
    return isTargetPath(pathValue, files.targetRelativePath)
      ? `${pathValue} ← target`
      : pathValue;
  });
  const listBlock = chartLines.join('\n');
  if (listBlock && listBlock.length + 1 <= remaining()) {
    lines.push(listBlock);
  } else if (files.charts.length > 0) {
    const groups = new Map<string, { count: number; hasTarget: boolean }>();
    for (const chart of files.charts) {
      const pathValue = chart.relativePath || chart.name;
      const folder = firstFolder(pathValue);
      const existing = groups.get(folder) || { count: 0, hasTarget: false };
      existing.count += 1;
      if (isTargetPath(pathValue, files.targetRelativePath)) {
        existing.hasTarget = true;
      }
      groups.set(folder, existing);
    }
    const groupLines = [...groups.entries()].map(([folder, group]) => {
      const label = folder ? `${folder}/` : '(root)';
      const targetMark = group.hasTarget ? ' · target' : '';
      return `${label} — ${group.count}${targetMark}`;
    });
    const groupBlock = groupLines.join('\n');
    if (groupBlock && groupBlock.length + 1 <= remaining()) {
      lines.push(groupBlock);
    }
  }

  if (files.audio.length > 0) {
    const audioLine = `Audio: ${files.audio.map((file) => file.name).join(', ')}`;
    if (audioLine.length + 1 <= remaining()) {
      lines.push(audioLine);
    }
  }

  return clipDiscordFieldValue(currentText());
}

export type LevelFileEmbedMode = 'update' | 'upload';

export function addLevelFileEmbedDetails(
  embed: MessageBuilder,
  snapshot: Pick<
    DiscordLevelFileSnapshot,
    'newFileId' | 'zipFilename' | 'zipSizeBytes' | 'uploadSource' | 'files' | 'newChartStats'
  > & {
    previousSource?: DiscordLevelPreviousSource;
    originalPath?: string;
    oldChartStats?: DiscordLevelChartStatsSnapshot;
  },
  mode: LevelFileEmbedMode,
): void {
  if (mode === 'update' && snapshot.previousSource && snapshot.originalPath) {
    embed.addField(
      'Previous',
      formatPreviousSourceField(snapshot.previousSource, snapshot.originalPath),
      false,
    );
  }

  if (snapshot.newFileId) {
    embed.addField('New file', clipDiscordFieldValue(snapshot.newFileId), false);
  }

  const archiveParts: string[] = [];
  if (snapshot.zipFilename) {
    archiveParts.push(snapshot.zipFilename);
  }
  if (typeof snapshot.zipSizeBytes === 'number' && Number.isFinite(snapshot.zipSizeBytes)) {
    archiveParts.push(formatZipSize(snapshot.zipSizeBytes));
  }
  if (archiveParts.length > 0) {
    embed.addField('Archive', clipDiscordFieldValue(archiveParts.join(' · ')), false);
  }

  if (snapshot.uploadSource) {
    embed.addField('Upload', clipDiscordFieldValue(formatUploadSource(snapshot.uploadSource)), false);
  }

  const statsText =
    mode === 'update'
      ? formatChartStatsDiff(snapshot.oldChartStats, snapshot.newChartStats)
      : formatChartStatsNew(snapshot.newChartStats);
  if (statsText) {
    embed.addField('Chart stats', statsText, false);
  }

  if (snapshot.files) {
    embed.addField('Files', formatZipFilesField(snapshot.files), false);
  }
}

export function hasLevelFileSnapshot(
  payload: Partial<DiscordLevelFileSnapshot> | null | undefined,
): boolean {
  return typeof payload?.newFileId === 'string' && payload.newFileId.length > 0;
}
