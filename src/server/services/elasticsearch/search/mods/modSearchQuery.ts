import type {estypes} from '@elastic/elasticsearch';

export const MOD_SEARCH_DEFAULT_LIMIT = 30;
export const MOD_SEARCH_MAX_LIMIT = 100;
export const MOD_SEARCH_MAX_OFFSET = 10_000;

export const MOD_SORT_VALUES = [
  'name-asc',
  'name-desc',
  'date-desc',
  'date-asc',
  'creator-asc',
  'creator-desc',
] as const;

export type ModSort = (typeof MOD_SORT_VALUES)[number];

export type ModSearchOptions = {
  q?: string;
  includeHidden?: boolean;
  limit?: number;
  offset?: number;
  sort?: ModSort;
};

export function parseModSearchQ(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

export function parseModOffset(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MOD_SEARCH_MAX_OFFSET);
}

export function parseModLimit(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return MOD_SEARCH_DEFAULT_LIMIT;
  return Math.min(MOD_SEARCH_MAX_LIMIT, Math.max(1, n));
}

export function parseModSort(raw: unknown): ModSort {
  if (typeof raw === 'string' && (MOD_SORT_VALUES as readonly string[]).includes(raw)) {
    return raw as ModSort;
  }
  return 'name-asc';
}

function escapeWildcard(value: string): string {
  return value.replace(/[\\*?]/g, (ch) => `\\${ch}`);
}

export function buildModTextShould(text: string): Record<string, unknown>[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const lc = trimmed.toLowerCase();
  const wildcardValue = `*${escapeWildcard(lc)}*`;
  const prefixValue = `${escapeWildcard(lc)}*`;
  return [
    {term: {'searchText.lower': {value: lc, boost: 10, case_insensitive: true}}},
    {wildcard: {'searchText.lower': {value: prefixValue, boost: 5, case_insensitive: true}}},
    {wildcard: {'searchText.lower': {value: wildcardValue, boost: 2, case_insensitive: true}}},
    {match: {searchText: {query: trimmed, boost: 1}}},
  ];
}

export function buildModSearchQuery(options: ModSearchOptions): Record<string, unknown> {
  const filter: Record<string, unknown>[] = [];
  if (!options.includeHidden) {
    filter.push({term: {hidden: false}});
  }
  const should = options.q ? buildModTextShould(options.q) : [];
  const bool: Record<string, unknown> = {};
  if (should.length) {
    bool.should = should;
    bool.minimum_should_match = 1;
  }
  if (filter.length) bool.filter = filter;
  if (!Object.keys(bool).length) return {match_all: {}};
  return {bool};
}

export function buildModSearchSort(sort: ModSort = 'name-asc'): estypes.Sort {
  const byId = {id: {order: 'asc' as const}};
  const byNameAsc = {'name.lower': {order: 'asc' as const}};
  switch (sort) {
    case 'name-desc':
      return [{'name.lower': {order: 'desc'}}, byId];
    case 'date-desc':
      return [{sourceUploadedAt: {order: 'desc', missing: '_last'}}, byNameAsc, byId];
    case 'date-asc':
      return [{sourceUploadedAt: {order: 'asc', missing: '_first'}}, byNameAsc, byId];
    case 'creator-asc':
      return [{creatorSortKey: {order: 'asc', missing: '_last'}}, byNameAsc, byId];
    case 'creator-desc':
      return [{creatorSortKey: {order: 'desc', missing: '_last'}}, byNameAsc, byId];
    case 'name-asc':
    default:
      return [byNameAsc, byId];
  }
}
