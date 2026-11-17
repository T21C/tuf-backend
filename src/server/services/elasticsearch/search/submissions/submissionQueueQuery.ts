import type { estypes } from '@elastic/elasticsearch';
import {
  isPendingSubmissionSort,
  type PendingSubmissionSort,
  type PendingSubmissionSortDir,
} from '@/server/services/submissions/pendingSubmissionSort.js';
import {
  parseHiddenPassDifficultySubtypes,
  type PassDifficultySubtype,
} from '@/server/services/submissions/passDifficultySubtype.js';

export type SubmissionQueueSearchAfter = Array<string | number | boolean | null>;

export type SubmissionQueueCursor = {
  v: 2;
  sort: PendingSubmissionSort;
  dir: PendingSubmissionSortDir;
  hide: PassDifficultySubtype[];
  q: string;
  after: SubmissionQueueSearchAfter;
};

function queryString(value: unknown): string {
  if (Array.isArray(value)) return queryString(value[0]);
  return typeof value === 'string' ? value : '';
}

function escapeWildcard(value: string): string {
  return value.replace(/[\\*?]/g, (ch) => `\\${ch}`);
}

export function buildSubmissionQueueTextShould(text: string): Record<string, unknown>[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const lc = trimmed.toLowerCase();
  const wildcardValue = `*${escapeWildcard(lc)}*`;
  const prefixValue = `${escapeWildcard(lc)}*`;
  return [
    { term: { 'searchText.lower': { value: lc, boost: 10, case_insensitive: true } } },
    { wildcard: { 'searchText.lower': { value: prefixValue, boost: 5, case_insensitive: true } } },
    { wildcard: { 'searchText.lower': { value: wildcardValue, boost: 2, case_insensitive: true } } },
    { match: { searchText: { query: trimmed, boost: 1 } } },
  ];
}

export function buildSubmissionQueueQuery(options: {
  kind: 'pass' | 'level';
  q?: string;
  hide?: readonly string[];
}): Record<string, unknown> {
  const filter: Record<string, unknown>[] = [{ term: { kind: options.kind } }];
  const hide = options.hide || [];
  if (hide.length > 0) {
    filter.push({ bool: { must_not: { terms: { difficultySubtype: [...hide] } } } });
  }
  const should = options.q ? buildSubmissionQueueTextShould(options.q) : [];
  const bool: Record<string, unknown> = { filter };
  if (should.length) {
    bool.should = should;
    bool.minimum_should_match = 1;
  }
  return { bool };
}

function orderedField(
  field: string,
  dir: PendingSubmissionSortDir,
  missing: '_last' | '_first' = '_last',
): Record<string, unknown> {
  return { [field]: { order: dir, missing } };
}

/** Unlocked first, then the selected field, then id descending. Missing ratio/difficulty sort last. */
export function buildSubmissionQueueSort(
  sort: PendingSubmissionSort,
  dir: PendingSubmissionSortDir,
): estypes.Sort {
  const unlockedFirst = { isLocked: { order: 'asc' as const } };
  const byId = { id: { order: 'desc' as const } };
  if (sort === 'difficulty') {
    return [unlockedFirst, orderedField('difficultySort', dir), byId] as estypes.Sort;
  }
  if (sort === 'ratio') {
    return [
      unlockedFirst,
      orderedField('ratio', dir),
      orderedField('acceptedCount', dir),
      orderedField('decidedCount', dir),
      byId,
    ] as estypes.Sort;
  }
  return [unlockedFirst, { createdAt: { order: dir } }, byId] as estypes.Sort;
}

export function encodeSubmissionQueueCursor(cursor: SubmissionQueueCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function asSearchAfter(value: unknown): SubmissionQueueSearchAfter | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const after: SubmissionQueueSearchAfter = [];
  for (const item of value) {
    if (item == null) {
      after.push(null);
      continue;
    }
    if (typeof item === 'string' || typeof item === 'boolean') {
      after.push(item);
      continue;
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      after.push(item);
      continue;
    }
    return null;
  }
  return after;
}

export function decodeSubmissionQueueCursor(raw: unknown): SubmissionQueueCursor | null {
  const encoded = queryString(raw).trim();
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      v?: unknown;
      sort?: unknown;
      dir?: unknown;
      hide?: unknown;
      q?: unknown;
      after?: unknown;
    };
    if (parsed.v !== 2) return null;
    if (typeof parsed.sort !== 'string' || !isPendingSubmissionSort(parsed.sort)) return null;
    if (parsed.dir !== 'asc' && parsed.dir !== 'desc') return null;
    const hideRaw = Array.isArray(parsed.hide) ? parsed.hide.join(',') : '';
    const hide = parseHiddenPassDifficultySubtypes(hideRaw);
    if ('error' in hide) return null;
    const after = asSearchAfter(parsed.after);
    if (!after) return null;
    return {
      v: 2,
      sort: parsed.sort,
      dir: parsed.dir,
      hide,
      q: typeof parsed.q === 'string' ? parsed.q : '',
      after,
    };
  } catch {
    return null;
  }
}

export function cursorMatchesQuery(
  cursor: SubmissionQueueCursor,
  query: {
    sort: PendingSubmissionSort;
    dir: PendingSubmissionSortDir;
    hide: readonly string[];
    q: string;
  },
): boolean {
  if (cursor.sort !== query.sort || cursor.dir !== query.dir || cursor.q !== query.q) return false;
  if (cursor.hide.length !== query.hide.length) return false;
  return cursor.hide.every((item, index) => item === query.hide[index]);
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function sortValueFromSource(
  source: {
    createdAt?: string | null;
    difficultySort?: number | null;
    ratio?: number | null;
  },
  sort: PendingSubmissionSort,
): number | null {
  if (sort === 'submitted') {
    const time = new Date(source.createdAt || '').getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (sort === 'difficulty') {
    return finiteNumber(source.difficultySort);
  }
  return finiteNumber(source.ratio);
}
