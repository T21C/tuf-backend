/** Pure request-list search parsing. No database or environment access. */
import {
  parseSearchQuery,
  queryParserConfigs,
  type FieldSearch,
  type SearchGroup,
} from '@/misc/utils/data/queryParser.js';
import {
  isLevelRequestStatus,
  isLevelRequestType,
  LEVEL_REQUEST_STATUSES,
  LEVEL_REQUEST_TYPES,
  type LevelRequestStatus,
  type LevelRequestType,
} from '@/misc/utils/data/levelRequestValidation.js';

export const REQUEST_SEARCH_MAX_Q = 200;

const STATUS_ALIASES: Record<string, LevelRequestStatus> = {
  rating: 'added_to_rating_page',
  rating_page: 'added_to_rating_page',
  added_to_rating: 'added_to_rating_page',
  discord: 'discord_vote',
  vote: 'discord_vote',
};

const TYPE_ALIASES: Record<string, LevelRequestType> = {
  info: 'info_change',
  infochange: 'info_change',
  'curation-rerate': 'curation_rerate',
  curationrerate: 'curation_rerate',
};

function compactToken(value: string): string {
  return value.toLowerCase().trim().replace(/[\s-]+/g, '_');
}

export function matchRequestStatuses(value: string, exact: boolean): LevelRequestStatus[] {
  const needle = compactToken(value);
  if (!needle) return [];
  const alias = STATUS_ALIASES[needle];
  if (exact) {
    if (isLevelRequestStatus(needle)) return [needle];
    return alias ? [alias] : [];
  }
  const matches = LEVEL_REQUEST_STATUSES.filter((status) => status.includes(needle));
  if (alias && !matches.includes(alias)) matches.push(alias);
  return matches;
}

export function matchRequestTypes(value: string, exact: boolean): LevelRequestType[] {
  const needle = compactToken(value);
  if (!needle) return [];
  const alias = TYPE_ALIASES[needle] || TYPE_ALIASES[needle.replace(/_/g, '')];
  if (exact) {
    if (isLevelRequestType(needle)) return [needle];
    return alias ? [alias] : [];
  }
  const compactNeedle = needle.replace(/_/g, '');
  const matches = LEVEL_REQUEST_TYPES.filter((type) => (
    type.includes(needle) || type.replace(/_/g, '').includes(compactNeedle)
  ));
  if (alias && !matches.includes(alias)) matches.push(alias);
  return matches;
}

export function rewriteRequestSearchTerm(term: FieldSearch): FieldSearch {
  const value = term.value.trim();
  if (term.field === 'any' && /^#\d+$/.test(value)) {
    return {field: 'level', value: value.slice(1), exact: true, isNot: term.isNot};
  }
  if ((term.field === 'level' || term.field === 'levelid' || term.field === 'id') && value.startsWith('#')) {
    return {
      ...term,
      field: term.field === 'id' ? 'id' : 'level',
      value: value.replace(/^#/, ''),
    };
  }
  if (term.field === 'levelid' || term.field === 'level') {
    return {...term, field: 'level', value};
  }
  if (term.field === 'user' || term.field === 'username' || term.field === 'requester') {
    return {...term, field: 'requester', value};
  }
  return {...term, value};
}

export function parseLevelRequestSearchQuery(query: string): SearchGroup[] {
  return parseSearchQuery(query, queryParserConfigs.request).map((group) => ({
    ...group,
    terms: group.terms.map(rewriteRequestSearchTerm),
  }));
}

export function requestSearchHasStatusField(groups: SearchGroup[]): boolean {
  return groups.some((group) => group.terms.some((term) => term.field === 'status'));
}

export function parsePositiveSearchInt(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const id = Number(trimmed);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}
