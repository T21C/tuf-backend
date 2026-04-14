import { prepareSearchTerm } from '@/misc/utils/data/searchHelpers.js';
import { queryParserConfigs, type FieldSearch } from '@/misc/utils/data/queryParser.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { BoolQueryBuilder } from '@/server/services/elasticsearch/search/esQueryBuilder.js';
import {
  matchNone,
  maybeNot,
  termField,
  wildcardCi,
  boolShouldOnly,
} from '@/server/services/elasticsearch/search/esQueryPrimitives.js';
import {
  specAnyLevelCreditsCreator,
  specAnyTeamObjectWithAliases,
  specLevelCreditsByCreatorRole,
  specLevelAliasesByField,
  specNestedDocNameWithOptionalAliases,
  specTeamFieldSearch,
} from '@/server/services/elasticsearch/search/esQuerySpecs.js';

export function buildFieldSearchQuery(fieldSearch: FieldSearch, excludeAliases = false): any {
  const { field, value, exact, isNot } = fieldSearch;
  const searchValue = prepareSearchTerm(value);
  logger.debug(`Building search query - Field: ${field}, PUA value: ${value}, Prepared value: ${searchValue}`);

  const numericFields = queryParserConfigs.level.numericFields || [];
  const isNumericField = numericFields.includes(field);

  if (isNumericField && field !== 'any') {
    const numericValue = parseInt(searchValue, 10);

    if (!isNaN(numericValue)) {
      return maybeNot(isNot, termField(field, numericValue));
    } else {
      return matchNone();
    }
  }

  if (field !== 'any') {
    const wildcardValue = exact ? searchValue : `*${searchValue}*`;
    if (field === 'charter' || field === 'vfxer' || field === 'creator') {
      const role = field === 'charter' || field === 'vfxer' ? field : undefined;
      return maybeNot(
        isNot,
        specLevelCreditsByCreatorRole({ wildcardValue, excludeAliases, role }),
      );
    }

    if (field === 'legacydllink') {
      return maybeNot(isNot, wildcardCi('legacyDllink', wildcardValue));
    }

    if (field === 'dllink') {
      return maybeNot(isNot, wildcardCi('dlLink', wildcardValue));
    }

    if (field === 'videolink') {
      return maybeNot(isNot, wildcardCi('videoLink', wildcardValue));
    }

    if (field === 'song') {
      const nestedSong = specNestedDocNameWithOptionalAliases({
        rootNestedPath: 'songObject',
        nameField: 'songObject.name',
        aliasNestedPath: 'songObject.aliases',
        aliasField: 'songObject.aliases.alias',
        wildcardValue,
        excludeAliases,
        ignoreUnmapped: true,
      });
      const query = new BoolQueryBuilder()
        .should(nestedSong)
        .should(excludeAliases ? matchNone() : specLevelAliasesByField({ field: 'song', wildcardValue }))
        .should(wildcardCi('song', wildcardValue))
        .build();
      return maybeNot(isNot, query);
    }

    if (field === 'artist') {
      const query = new BoolQueryBuilder()
        .should(
          specNestedDocNameWithOptionalAliases({
            rootNestedPath: 'primaryArtist',
            nameField: 'primaryArtist.name',
            aliasNestedPath: 'primaryArtist.aliases',
            aliasField: 'primaryArtist.aliases.alias',
            wildcardValue,
            excludeAliases,
            ignoreUnmapped: true,
          }),
        )
        .should(
          specNestedDocNameWithOptionalAliases({
            rootNestedPath: 'artists',
            nameField: 'artists.name',
            aliasNestedPath: 'artists.aliases',
            aliasField: 'artists.aliases.alias',
            wildcardValue,
            excludeAliases,
            ignoreUnmapped: true,
          }),
        )
        .should(excludeAliases ? matchNone() : specLevelAliasesByField({ field: 'artist', wildcardValue }))
        .should(wildcardCi('artist', wildcardValue))
        .build();
      return maybeNot(isNot, query);
    }

    if (field === 'team') {
      return maybeNot(isNot, specTeamFieldSearch({ wildcardValue, excludeAliases }));
    }

    return maybeNot(isNot, wildcardCi(field, wildcardValue));
  }

  const wildcardValue = exact ? searchValue : `*${searchValue}*`;
  const query = boolShouldOnly([
    specNestedDocNameWithOptionalAliases({
      rootNestedPath: 'songObject',
      nameField: 'songObject.name',
      aliasNestedPath: 'songObject.aliases',
      aliasField: 'songObject.aliases.alias',
      wildcardValue,
      excludeAliases,
      ignoreUnmapped: true,
    }),
    ...(excludeAliases ? [] : [specLevelAliasesByField({ field: 'song', wildcardValue })]),
    wildcardCi('song', wildcardValue),
    specNestedDocNameWithOptionalAliases({
      rootNestedPath: 'primaryArtist',
      nameField: 'primaryArtist.name',
      aliasNestedPath: 'primaryArtist.aliases',
      aliasField: 'primaryArtist.aliases.alias',
      wildcardValue,
      excludeAliases,
      ignoreUnmapped: true,
    }),
    specNestedDocNameWithOptionalAliases({
      rootNestedPath: 'artists',
      nameField: 'artists.name',
      aliasNestedPath: 'artists.aliases',
      aliasField: 'artists.aliases.alias',
      wildcardValue,
      excludeAliases,
      ignoreUnmapped: true,
    }),
    ...(excludeAliases ? [] : [specLevelAliasesByField({ field: 'artist', wildcardValue })]),
    specAnyLevelCreditsCreator({ wildcardValue, excludeAliases }),
    specAnyTeamObjectWithAliases({ wildcardValue, excludeAliases }),
  ]);
  return maybeNot(isNot, query);
}
