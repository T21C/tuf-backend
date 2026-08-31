import type {estypes} from '@elastic/elasticsearch';
import type {PublicTournamentStatus} from '@/server/services/tournaments/serializePublicTournament.js';

export const TOURNAMENT_SEARCH_DEFAULT_LIMIT = 200;
export const TOURNAMENT_SEARCH_MAX_LIMIT = 500;
export const TOURNAMENT_SEARCH_MAX_OFFSET = 10_000;

export type TournamentSearchOptions = {
  q?: string;
  status?: PublicTournamentStatus;
  includeHidden?: boolean;
  includeDraft?: boolean;
  limit?: number;
  offset?: number;
};

export function parseTournamentSearchQ(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

export function parseTournamentOffset(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, TOURNAMENT_SEARCH_MAX_OFFSET);
}

export function parseTournamentLimit(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return TOURNAMENT_SEARCH_DEFAULT_LIMIT;
  return Math.min(TOURNAMENT_SEARCH_MAX_LIMIT, Math.max(1, n));
}

function escapeWildcard(value: string): string {
  return value.replace(/[\\*?]/g, ch => `\\${ch}`);
}

export function buildTournamentTextShould(text: string): Record<string, unknown>[] {
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

export function buildTournamentSearchQuery(options: TournamentSearchOptions): Record<string, unknown> {
  const filter: Record<string, unknown>[] = [];
  if (!options.includeHidden) {
    filter.push({term: {isHidden: false}});
  }
  if (!options.includeDraft) {
    filter.push({bool: {must_not: [{term: {status: 'draft'}}]}});
  }
  if (options.status) {
    filter.push({term: {status: options.status}});
  }
  const should = options.q ? buildTournamentTextShould(options.q) : [];
  const bool: Record<string, unknown> = {};
  if (should.length) {
    bool.should = should;
    bool.minimum_should_match = 1;
  }
  if (filter.length) bool.filter = filter;
  if (!Object.keys(bool).length) return {match_all: {}};
  return {bool};
}

export function buildTournamentSearchSort(): estypes.Sort {
  return [
    {seriesSortWeight: {order: 'asc'}},
    {sortWeight: {order: 'asc'}},
    {sortYear: {order: 'desc', missing: '_last'}},
    {'shortName.lower': {order: 'asc'}},
    {id: {order: 'asc'}},
  ];
}
