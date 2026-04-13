import { parseSearchQuery, queryParserConfigs, type SearchGroup } from '@/misc/utils/data/queryParser.js';
import { convertToPUA } from '@/misc/utils/data/searchHelpers.js';

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
