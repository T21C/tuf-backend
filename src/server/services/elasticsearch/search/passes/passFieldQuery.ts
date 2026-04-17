import { prepareSearchTerm } from '@/misc/utils/data/searchHelpers.js';
import { queryParserConfigs, type FieldSearch } from '@/misc/utils/data/queryParser.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { BoolQueryBuilder } from '@/server/services/elasticsearch/search/tools/esQueryBuilder/esQueryBuilder.js';
import {
  matchNone,
  maybeNot,
  nestedQuery,
  termField,
  wildcardCi,
} from '@/server/services/elasticsearch/search/tools/esQueryBuilder/esQueryPrimitives.js';

export function buildPassFieldSearchQuery(fieldSearch: FieldSearch): any {
  const { field, value, exact, isNot } = fieldSearch;
  const searchValue = prepareSearchTerm(value);
  logger.debug(`Building pass search query - Field: ${field}, PUA value: ${value}, Prepared value: ${searchValue}`);

  const numericFields = queryParserConfigs.pass.numericFields || [];
  const isNumericField = numericFields.includes(field);

  if (isNumericField && field !== 'any') {
    const numericValue = parseInt(searchValue, 10);

    if (!isNaN(numericValue)) {
      return maybeNot(isNot, termField(field, numericValue));
    } else {
      logger.warn(`Invalid numeric value for field ${field}: ${searchValue}`);
      return matchNone();
    }
  }

  if (field !== 'any') {
    const wildcardValue = exact ? searchValue : `*${searchValue}*`;

    if (field === 'player') {
      const query = new BoolQueryBuilder()
        .should(wildcardCi('player.name', wildcardValue))
        .should(wildcardCi('player.username', wildcardValue))
        .build();
      return maybeNot(isNot, query);
    }

    if (field === 'video') {
      return maybeNot(isNot, wildcardCi('videoLink', wildcardValue));
    }

    if (field === 'vidtitle') {
      return maybeNot(isNot, wildcardCi('vidTitle', wildcardValue));
    }

    if (field === 'level.song') {
      return maybeNot(isNot, wildcardCi('level.song', wildcardValue));
    }

    if (field === 'level.artist') {
      return maybeNot(isNot, wildcardCi('level.artist', wildcardValue));
    }

    if (field === 'level.dlLink') {
      return maybeNot(isNot, wildcardCi('level.dlLink', wildcardValue));
    }

    return maybeNot(isNot, wildcardCi(field, wildcardValue));
  }

  const wildcardValue = `*${searchValue}*`;
  const query = new BoolQueryBuilder()
    .should(wildcardCi('player.name', wildcardValue))
    .should(wildcardCi('player.username', wildcardValue))
    .should(wildcardCi('level.song', wildcardValue))
    .should(wildcardCi('level.artist', wildcardValue))
    .should(wildcardCi('videoLink', wildcardValue))
    .should(wildcardCi('vidTitle', wildcardValue))
    .should(wildcardCi('level.dlLink', wildcardValue))
    .should(nestedQuery('level.aliases', wildcardCi('level.aliases.alias', wildcardValue)))
    .build();
  return maybeNot(isNot, query);
}
