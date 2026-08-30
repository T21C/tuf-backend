import type {estypes} from '@elastic/elasticsearch';
import {
  buildFacetDomainClause,
  type FacetQueryV1,
} from '@/misc/utils/search/facetQuery.js';

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
  facetQueryV1?: FacetQueryV1 | null;
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
  return 'date-desc';
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
  if (options.facetQueryV1?.tags) {
    const tagClause = buildFacetDomainClause(options.facetQueryV1.tags, 'tags', 'tags.id');
    if (tagClause) filter.push(tagClause);
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

const PIN_FIRST = {isPinned: {order: 'desc' as const}};

export function buildModSearchSort(sort: ModSort = 'date-desc'): estypes.Sort {
  const byId = {id: {order: 'asc' as const}};
  const byNameAsc = {'name.lower': {order: 'asc' as const}};
  switch (sort) {
    case 'name-desc':
      return [PIN_FIRST, {'name.lower': {order: 'desc'}}, byId];
    case 'date-asc':
      return [PIN_FIRST, {sourceUploadedAt: {order: 'asc', missing: '_first'}}, byNameAsc, byId];
    case 'creator-asc':
      return [PIN_FIRST, {creatorSortKey: {order: 'asc', missing: '_last'}}, byNameAsc, byId];
    case 'creator-desc':
      return [PIN_FIRST, {creatorSortKey: {order: 'desc', missing: '_last'}}, byNameAsc, byId];
    case 'name-asc':
      return [PIN_FIRST, byNameAsc, byId];
    case 'date-desc':
    default:
      return [PIN_FIRST, {sourceUploadedAt: {order: 'desc', missing: '_last'}}, byNameAsc, byId];
  }
}
