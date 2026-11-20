export type RerateRow = {
  createdAt: string;
  previousDiffId: number | null;
  newDiffId: number | null;
};

export type DifficultyAtResult = {
  diffId: number;
  source: 'history' | 'snapshot' | 'current';
};

/**
 * Difficulty at vidUploadTime from rerate history.
 * Before the first recorded change, the difficulty is that row's previousDiffId.
 * With no history, the clear-time snapshot wins, then the chart's current difficulty.
 */
export function difficultyAt(input: {
  vidUploadTime: string | null;
  history: readonly RerateRow[];
  snapshotDiffId: number | null;
  currentDiffId: number;
}): DifficultyAtResult {
  const history = [...input.history]
    .filter((row) => row.previousDiffId != null && row.newDiffId != null && row.createdAt)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const when = input.vidUploadTime ? Date.parse(input.vidUploadTime) : NaN;
  if (history.length > 0 && Number.isFinite(when)) {
    const first = history[0];
    if (when < Date.parse(first.createdAt)) {
      return { diffId: first.previousDiffId as number, source: 'history' };
    }
    let diffId = first.newDiffId as number;
    for (const row of history) {
      if (when >= Date.parse(row.createdAt)) diffId = row.newDiffId as number;
    }
    return { diffId, source: 'history' };
  }
  if (input.snapshotDiffId != null) {
    return { diffId: input.snapshotDiffId, source: 'snapshot' };
  }
  return { diffId: input.currentDiffId, source: 'current' };
}

const UNKNOWN_WALLS = new Set(['2023-01-01 07:27:27', '2023-07-27 07:27:27']);

function wallClock(date: Date, utc: boolean): string {
  const year = utc ? date.getUTCFullYear() : date.getFullYear();
  const month = (utc ? date.getUTCMonth() : date.getMonth()) + 1;
  const day = utc ? date.getUTCDate() : date.getDate();
  const hour = utc ? date.getUTCHours() : date.getHours();
  const minute = utc ? date.getUTCMinutes() : date.getMinutes();
  const second = utc ? date.getUTCSeconds() : date.getSeconds();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

/** Missing times and the two placeholder upload stamps are not an order. */
export function isUnknownUploadTime(value: string | Date | null | undefined): boolean {
  if (value == null || value === '') return true;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return true;
  return UNKNOWN_WALLS.has(wallClock(date, true)) || UNKNOWN_WALLS.has(wallClock(date, false));
}
