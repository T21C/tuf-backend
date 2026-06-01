import { parseSearchQuery, queryParserConfigs, type SearchGroup } from '@/misc/utils/data/queryParser.js';
import { convertToPUA } from '@/misc/utils/data/searchHelpers.js';

export type LevelSearchQueryNormalizeResult =
  | { ok: true; query: string }
  | { ok: false; error: string };

const LEVEL_ID_HASHTAG_ERROR = 'Invalid level ID format after hashtag';

/**
 * Normalizes level search input for Elasticsearch.
 * `#123` is rewritten to `id:123` (same as the public level search help text).
 */
export function normalizeLevelSearchQuery(raw: string): LevelSearchQueryNormalizeResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, query: '' };
  }
  if (trimmed.startsWith('#') && trimmed.length > 1) {
    const idStr = trimmed.slice(1);
    if (!/^\d+$/.test(idStr)) {
      return { ok: false, error: LEVEL_ID_HASHTAG_ERROR };
    }
    return { ok: true, query: `id:${idStr}` };
  }
  return { ok: true, query: trimmed };
}

export function parseSearchQueryWithPUA(query: string, isPassSearch = false): SearchGroup[] {
  const config = isPassSearch ? queryParserConfigs.pass : queryParserConfigs.level;
  const groups = parseSearchQuery(query, config);

  return groups.map(group => ({
    ...group,
    terms: group.terms.map(term => ({
      ...term,
      value: convertToPUA(term.value),
    })),
  }));
}
