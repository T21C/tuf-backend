import {
  isPendingSubmissionSort,
  type PendingSubmissionSort,
  type PendingSubmissionSortDir,
} from './pendingSubmissionSort.js';
import {
  parseHiddenPassDifficultySubtypes,
  type PassDifficultySubtype,
} from './passDifficultySubtype.js';
import {
  decodeSubmissionQueueCursor,
  type SubmissionQueueCursor,
} from '@/server/services/elasticsearch/search/submissions/submissionQueueQuery.js';

export const PENDING_SUBMISSION_PAGE_DEFAULT = 15;
export const PENDING_SUBMISSION_PAGE_MAX = 30;

export type { PendingSubmissionSort, PendingSubmissionSortDir };

export type PendingSubmissionCursor = {
  isLocked: 0 | 1;
  createdAt: string;
  id: number;
  sort: PendingSubmissionSort;
  dir: PendingSubmissionSortDir;
  /** Numeric rank for `sort`. Null sorts after every real value. */
  value: number | null;
  /** Accepted submissions. Set for ratio sorts; higher follows `dir` when ratios match. */
  tie?: number | null;
  /** Accepted plus declined. Set for ratio sorts, after `tie`. */
  volume?: number | null;
};

export type PendingSubmissionListQuery = {
  limit: number;
  cursor: SubmissionQueueCursor | null;
  q: string;
  ids: number[] | null;
  sort: PendingSubmissionSort;
  dir: PendingSubmissionSortDir;
  hide: PassDifficultySubtype[];
};

export type PendingRowKey = {
  id: number;
  isLocked?: boolean | number | null;
  createdAt: Date | string;
  sortValue?: number | null;
  sortTie?: number | null;
  sortVolume?: number | null;
};

export type PendingSortRow = {
  id: number;
  isLocked?: boolean | number | null;
  sortValue: number | null;
  sortTie?: number | null;
  sortVolume?: number | null;
};

function queryString(value: unknown): string {
  if (Array.isArray(value)) return queryString(value[0]);
  return typeof value === 'string' ? value : '';
}

function parseDir(value: unknown): PendingSubmissionSortDir | null {
  const dir = queryString(value).trim().toLowerCase();
  return dir === 'asc' || dir === 'desc' ? dir : null;
}

function asSortNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function cursorFromPendingRow(
  row: PendingRowKey,
  sort: PendingSubmissionSort = 'submitted',
  dir: PendingSubmissionSortDir = 'desc',
): PendingSubmissionCursor {
  const time = new Date(row.createdAt).getTime();
  const createdAt = Number.isFinite(time) ? new Date(time).toISOString() : new Date(0).toISOString();
  let value: number | null;
  if (sort === 'submitted') {
    value = Number.isFinite(time) ? time : null;
  } else {
    value = asSortNumber(row.sortValue);
  }
  const cursor: PendingSubmissionCursor = {
    isLocked: row.isLocked ? 1 : 0,
    createdAt,
    id: row.id,
    sort,
    dir,
    value,
  };
  if (sort === 'ratio') {
    cursor.tie = asSortNumber(row.sortTie) ?? 0;
    cursor.volume = asSortNumber(row.sortVolume) ?? 0;
  }
  return cursor;
}

export function encodePendingSubmissionCursor(cursor: PendingSubmissionCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodePendingSubmissionCursor(raw: unknown): PendingSubmissionCursor | null {
  const encoded = queryString(raw).trim();
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      isLocked?: unknown;
      createdAt?: unknown;
      id?: unknown;
      sort?: unknown;
      dir?: unknown;
      value?: unknown;
      tie?: unknown;
      volume?: unknown;
    };
    const isLocked = parsed.isLocked === 1 || parsed.isLocked === true
      ? 1
      : parsed.isLocked === 0 || parsed.isLocked === false
        ? 0
        : null;
    const id = Number(parsed.id);
    const createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : '';
    const time = Date.parse(createdAt);
    if (isLocked === null || !Number.isInteger(id) || id <= 0 || Number.isNaN(time)) return null;

    const sort = parsed.sort == null
      ? 'submitted'
      : (typeof parsed.sort === 'string' && isPendingSubmissionSort(parsed.sort) ? parsed.sort : null);
    const dir = parsed.dir == null ? 'desc' : parseDir(parsed.dir);
    if (!sort || !dir) return null;

    let value: number | null;
    if (parsed.value == null && !Object.prototype.hasOwnProperty.call(parsed, 'value')) {
      if (sort !== 'submitted') return null;
      value = time;
    } else if (parsed.value === null) {
      if (sort === 'submitted') return null;
      value = null;
    } else {
      value = asSortNumber(parsed.value);
      if (value == null) return null;
    }

    const cursor: PendingSubmissionCursor = {
      isLocked,
      createdAt: new Date(time).toISOString(),
      id,
      sort,
      dir,
      value,
    };
    if (Object.prototype.hasOwnProperty.call(parsed, 'tie')) {
      const tie = parsed.tie === null ? null : asSortNumber(parsed.tie);
      if (parsed.tie !== null && tie == null) return null;
      cursor.tie = tie;
    }
    if (Object.prototype.hasOwnProperty.call(parsed, 'volume')) {
      const volume = parsed.volume === null ? null : asSortNumber(parsed.volume);
      if (parsed.volume !== null && volume == null) return null;
      cursor.volume = volume;
    }
    return cursor;
  } catch {
    return null;
  }
}

export function parsePendingSubmissionListQuery(query: {
  limit?: unknown;
  cursor?: unknown;
  q?: unknown;
  ids?: unknown;
  sort?: unknown;
  dir?: unknown;
  hide?: unknown;
}): PendingSubmissionListQuery | { error: string } {
  const limitRaw = queryString(query.limit).trim();
  let limit = PENDING_SUBMISSION_PAGE_DEFAULT;
  if (limitRaw) {
    const parsedLimit = Number(limitRaw);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > PENDING_SUBMISSION_PAGE_MAX) {
      return { error: `limit must be an integer from 1 to ${PENDING_SUBMISSION_PAGE_MAX}` };
    }
    limit = parsedLimit;
  }

  const sortRaw = queryString(query.sort).trim().toLowerCase();
  let sort: PendingSubmissionSort = 'submitted';
  if (sortRaw) {
    if (!isPendingSubmissionSort(sortRaw)) return { error: 'Invalid sort' };
    sort = sortRaw;
  }

  const dirRaw = queryString(query.dir).trim().toLowerCase();
  let dir: PendingSubmissionSortDir = 'desc';
  if (dirRaw) {
    const parsedDir = parseDir(dirRaw);
    if (!parsedDir) return { error: 'Invalid dir' };
    dir = parsedDir;
  }

  const hide = parseHiddenPassDifficultySubtypes(query.hide);
  if ('error' in hide) return hide;

  const q = queryString(query.q).trim();
  const decoded = decodeSubmissionQueueCursor(query.cursor);
  const cursor = decoded
    && decoded.sort === sort
    && decoded.dir === dir
    && decoded.q === q
    && decoded.hide.length === hide.length
    && decoded.hide.every((item, index) => item === hide[index])
    ? decoded
    : null;

  const idsRaw = queryString(query.ids).trim();
  let ids: number[] | null = null;
  if (idsRaw) {
    const parsedIds = idsRaw.split(',').map((part) => Number(part.trim()));
    if (
      parsedIds.length === 0
      || parsedIds.length > PENDING_SUBMISSION_PAGE_MAX
      || parsedIds.some((id) => !Number.isInteger(id) || id <= 0)
    ) {
      return { error: `ids must be 1 to ${PENDING_SUBMISSION_PAGE_MAX} positive integers` };
    }
    ids = parsedIds;
  }

  return {
    limit,
    cursor,
    q,
    ids,
    sort,
    dir,
    hide,
  };
}

function resolveRowSortValue(row: PendingRowKey, sort: PendingSubmissionSort): number | null {
  if (row.sortValue === null) return null;
  if (row.sortValue != null) {
    const numeric = asSortNumber(row.sortValue);
    if (numeric != null) return numeric;
  }
  if (sort === 'submitted') {
    const time = new Date(row.createdAt).getTime();
    return Number.isFinite(time) ? time : null;
  }
  return null;
}

export function comparePendingBySort(
  a: PendingSortRow,
  b: PendingSortRow,
  dir: PendingSubmissionSortDir,
): number {
  const lockDelta = (a.isLocked ? 1 : 0) - (b.isLocked ? 1 : 0);
  if (lockDelta !== 0) return lockDelta;
  const aValue = asSortNumber(a.sortValue);
  const bValue = asSortNumber(b.sortValue);
  if (aValue == null || bValue == null) {
    if (aValue == null && bValue == null) return b.id - a.id;
    return aValue == null ? 1 : -1;
  }
  if (aValue !== bValue) {
    const delta = aValue - bValue;
    return dir === 'asc' ? delta : -delta;
  }
  const tieDelta = compareSortTie(a.sortTie, b.sortTie, dir);
  if (tieDelta !== 0) return tieDelta;
  const volumeDelta = compareSortTie(a.sortVolume, b.sortVolume, dir);
  if (volumeDelta !== 0) return volumeDelta;
  return b.id - a.id;
}

function compareSortTie(
  a: number | null | undefined,
  b: number | null | undefined,
  dir: PendingSubmissionSortDir,
): number {
  const aValue = asSortNumber(a);
  const bValue = asSortNumber(b);
  if (aValue == null || bValue == null || aValue === bValue) return 0;
  const delta = aValue - bValue;
  return dir === 'asc' ? delta : -delta;
}

export function isAfterPendingCursor(row: PendingRowKey, cursor: PendingSubmissionCursor): boolean {
  const sort = cursor.sort ?? 'submitted';
  return comparePendingBySort(
    {
      id: row.id,
      isLocked: row.isLocked,
      sortValue: resolveRowSortValue(row, sort),
      sortTie: row.sortTie,
      sortVolume: row.sortVolume,
    },
    {
      id: cursor.id,
      isLocked: cursor.isLocked,
      sortValue: cursor.value,
      sortTie: cursor.tie,
      sortVolume: cursor.volume,
    },
    cursor.dir ?? 'desc',
  ) > 0;
}

export function comparePendingSubmissions(a: PendingRowKey, b: PendingRowKey): number {
  const aTime = new Date(a.createdAt).getTime();
  const bTime = new Date(b.createdAt).getTime();
  return comparePendingBySort(
    { id: a.id, isLocked: a.isLocked, sortValue: Number.isFinite(aTime) ? aTime : null },
    { id: b.id, isLocked: b.isLocked, sortValue: Number.isFinite(bTime) ? bTime : null },
    'desc',
  );
}

export function slicePendingPage<T extends PendingRowKey>(
  ordered: T[],
  cursor: PendingSubmissionCursor | null,
  limit: number,
): { page: T[]; hasMore: boolean } {
  const after = cursor ? ordered.filter((row) => isAfterPendingCursor(row, cursor)) : ordered;
  return {
    page: after.slice(0, limit),
    hasMore: after.length > limit,
  };
}

export function pendingQueueRevision(total: number, latest: Date | string | number | null | undefined): string {
  const count = Number.isFinite(total) ? total : 0;
  if (latest == null || latest === '') return `${count}:0`;
  const latestMs = new Date(latest).getTime();
  return `${count}:${Number.isFinite(latestMs) ? latestMs : 0}`;
}
