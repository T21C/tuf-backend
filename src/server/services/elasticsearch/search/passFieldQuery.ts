import { prepareSearchTerm } from '@/misc/utils/data/searchHelpers.js';
import { queryParserConfigs, type FieldSearch } from '@/misc/utils/data/queryParser.js';
import { logger } from '@/server/services/core/LoggerService.js';

export function buildPassFieldSearchQuery(fieldSearch: FieldSearch): any {
  const { field, value, exact, isNot } = fieldSearch;
  const searchValue = prepareSearchTerm(value);
  logger.debug(`Building pass search query - Field: ${field}, PUA value: ${value}, Prepared value: ${searchValue}`);

  const numericFields = queryParserConfigs.pass.numericFields || [];
  const isNumericField = numericFields.includes(field);

  if (isNumericField && field !== 'any') {
    const numericValue = parseInt(searchValue, 10);

    if (!isNaN(numericValue)) {
      const query = {
        term: {
          [field]: numericValue,
        },
      };
      return isNot ? { bool: { must_not: [query] } } : query;
    } else {
      logger.warn(`Invalid numeric value for field ${field}: ${searchValue}`);
      return { bool: { must_not: [{ match_all: {} }] } };
    }
  }

  if (field !== 'any') {
    const wildcardValue = exact ? searchValue : `*${searchValue}*`;

    if (field === 'player') {
      const query = {
        bool: {
          should: [
            { wildcard: { 'player.name': { value: wildcardValue, case_insensitive: true } } },
            { wildcard: { 'player.username': { value: wildcardValue, case_insensitive: true } } },
          ],
          minimum_should_match: 1,
        },
      };
      return isNot ? { bool: { must_not: [query] } } : query;
    }

    if (field === 'video') {
      const query = {
        wildcard: {
          videoLink: {
            value: wildcardValue,
            case_insensitive: true,
          },
        },
      };
      return isNot ? { bool: { must_not: [query] } } : query;
    }

    if (field === 'vidtitle') {
      const query = {
        wildcard: {
          vidTitle: {
            value: wildcardValue,
            case_insensitive: true,
          },
        },
      };
      return isNot ? { bool: { must_not: [query] } } : query;
    }

    if (field === 'level.song') {
      const query = {
        wildcard: {
          'level.song': {
            value: wildcardValue,
            case_insensitive: true,
          },
        },
      };
      return isNot ? { bool: { must_not: [query] } } : query;
    }

    if (field === 'level.artist') {
      const query = {
        wildcard: {
          'level.artist': {
            value: wildcardValue,
            case_insensitive: true,
          },
        },
      };
      return isNot ? { bool: { must_not: [query] } } : query;
    }

    if (field === 'level.dlLink') {
      const query = {
        wildcard: {
          'level.dlLink': {
            value: wildcardValue,
            case_insensitive: true,
          },
        },
      };
      return isNot ? { bool: { must_not: [query] } } : query;
    }

    const searchCondition = {
      wildcard: {
        [field]: {
          value: wildcardValue,
          case_insensitive: true,
        },
      },
    };
    return isNot ? { bool: { must_not: [searchCondition] } } : searchCondition;
  }

  const wildcardValue = `*${searchValue}*`;
  const query = {
    bool: {
      should: [
        { wildcard: { 'player.name': { value: wildcardValue, case_insensitive: true } } },
        { wildcard: { 'player.username': { value: wildcardValue, case_insensitive: true } } },
        { wildcard: { 'level.song': { value: wildcardValue, case_insensitive: true } } },
        { wildcard: { 'level.artist': { value: wildcardValue, case_insensitive: true } } },
        { wildcard: { videoLink: { value: wildcardValue, case_insensitive: true } } },
        { wildcard: { vidTitle: { value: wildcardValue, case_insensitive: true } } },
        { wildcard: { 'level.dlLink': { value: wildcardValue, case_insensitive: true } } },
        {
          nested: {
            path: 'level.aliases',
            query: {
              wildcard: { 'level.aliases.alias': { value: wildcardValue, case_insensitive: true } },
            },
          },
        },
      ],
      minimum_should_match: 1,
    },
  };
  return isNot ? { bool: { must_not: [query] } } : query;
}
