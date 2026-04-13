import { prepareSearchTerm } from '@/misc/utils/data/searchHelpers.js';
import { queryParserConfigs, type FieldSearch } from '@/misc/utils/data/queryParser.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { BoolQueryBuilder } from '@/server/services/elasticsearch/search/esQueryBuilder.js';
import {
  matchNone,
  maybeNot,
  termField,
  wildcardCi,
} from '@/server/services/elasticsearch/search/esQueryPrimitives.js';
import { specNestedDocNameWithOptionalAliases } from '@/server/services/elasticsearch/search/esQuerySpecs.js';

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
      const query = {
        nested: {
          path: 'levelCredits',
          query: {
            bool: {
              must: [
                {
                  nested: {
                    path: 'levelCredits.creator',
                    query: {
                      bool: {
                        should: [
                          {
                            wildcard: {
                              'levelCredits.creator.name': {
                                value: wildcardValue,
                                case_insensitive: true,
                              },
                            },
                          },
                          ...(excludeAliases
                            ? []
                            : [
                                {
                                  nested: {
                                    path: 'levelCredits.creator.creatorAliases',
                                    query: {
                                      wildcard: {
                                        'levelCredits.creator.creatorAliases.name': {
                                          value: wildcardValue,
                                          case_insensitive: true,
                                        },
                                      },
                                    },
                                  },
                                },
                              ]),
                        ],
                        minimum_should_match: 1,
                      },
                    },
                  },
                },
                ...(field === 'charter' || field === 'vfxer'
                  ? [
                      {
                        term: {
                          'levelCredits.role': {
                            value: field,
                            case_insensitive: true,
                          },
                        },
                      },
                    ]
                  : []),
              ],
            },
          },
        },
      };
      return isNot ? { bool: { must_not: [query] } } : query;
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
        .should(wildcardCi('song', wildcardValue))
        .build();
      return maybeNot(isNot, query);
    }

    if (field === 'artist') {
      const query = {
        bool: {
          should: [
            {
              nested: {
                path: 'primaryArtist',
                ignore_unmapped: true,
                query: {
                  bool: {
                    should: [
                      {
                        wildcard: {
                          'primaryArtist.name': {
                            value: wildcardValue,
                            case_insensitive: true,
                          },
                        },
                      },
                      ...(excludeAliases
                        ? []
                        : [
                            {
                              nested: {
                                path: 'primaryArtist.aliases',
                                ignore_unmapped: true,
                                query: {
                                  wildcard: {
                                    'primaryArtist.aliases.alias': {
                                      value: wildcardValue,
                                      case_insensitive: true,
                                    },
                                  },
                                },
                              },
                            },
                          ]),
                    ],
                    minimum_should_match: 1,
                  },
                },
              },
            },
            {
              nested: {
                path: 'artists',
                ignore_unmapped: true,
                query: {
                  bool: {
                    should: [
                      {
                        wildcard: {
                          'artists.name': {
                            value: wildcardValue,
                            case_insensitive: true,
                          },
                        },
                      },
                      ...(excludeAliases
                        ? []
                        : [
                            {
                              nested: {
                                path: 'artists.aliases',
                                ignore_unmapped: true,
                                query: {
                                  wildcard: {
                                    'artists.aliases.alias': {
                                      value: wildcardValue,
                                      case_insensitive: true,
                                    },
                                  },
                                },
                              },
                            },
                          ]),
                    ],
                    minimum_should_match: 1,
                  },
                },
              },
            },
            {
              wildcard: {
                artist: {
                  value: wildcardValue,
                  case_insensitive: true,
                },
              },
            },
          ],
          minimum_should_match: 1,
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

    if (field === 'team') {
      const query = {
        bool: {
          should: [
            searchCondition,
            {
              nested: {
                path: 'teamObject',
                query: {
                  bool: {
                    should: [
                      {
                        wildcard: {
                          'teamObject.name': {
                            value: wildcardValue,
                            case_insensitive: true,
                          },
                        },
                      },
                      ...(excludeAliases
                        ? []
                        : [
                            {
                              nested: {
                                path: 'teamObject.aliases',
                                query: {
                                  wildcard: {
                                    'teamObject.aliases.name': {
                                      value: wildcardValue,
                                      case_insensitive: true,
                                    },
                                  },
                                },
                              },
                            },
                          ]),
                    ],
                  },
                },
              },
            },
          ],
        },
      };
      return isNot ? { bool: { must_not: [query] } } : query;
    }

    return isNot ? { bool: { must_not: [searchCondition] } } : searchCondition;
  }

  const wildcardValue = exact ? searchValue : `*${searchValue}*`;
  const query = {
    bool: {
      should: [
        {
          nested: {
            path: 'songObject',
            ignore_unmapped: true,
            query: {
              bool: {
                should: [
                  { wildcard: { 'songObject.name': { value: wildcardValue, case_insensitive: true } } },
                  ...(excludeAliases
                    ? []
                    : [
                        {
                          nested: {
                            path: 'songObject.aliases',
                            ignore_unmapped: true,
                            query: {
                              wildcard: { 'songObject.aliases.alias': { value: wildcardValue, case_insensitive: true } },
                            },
                          },
                        },
                      ]),
                ],
                minimum_should_match: 1,
              },
            },
          },
        },
        { wildcard: { song: { value: wildcardValue, case_insensitive: true } } },
        {
          nested: {
            path: 'primaryArtist',
            ignore_unmapped: true,
            query: {
              bool: {
                should: [
                  { wildcard: { 'primaryArtist.name': { value: wildcardValue, case_insensitive: true } } },
                  ...(excludeAliases
                    ? []
                    : [
                        {
                          nested: {
                            path: 'primaryArtist.aliases',
                            ignore_unmapped: true,
                            query: {
                              wildcard: { 'primaryArtist.aliases.alias': { value: wildcardValue, case_insensitive: true } },
                            },
                          },
                        },
                      ]),
                ],
                minimum_should_match: 1,
              },
            },
          },
        },
        {
          nested: {
            path: 'artists',
            ignore_unmapped: true,
            query: {
              bool: {
                should: [
                  { wildcard: { 'artists.name': { value: wildcardValue, case_insensitive: true } } },
                  ...(excludeAliases
                    ? []
                    : [
                        {
                          nested: {
                            path: 'artists.aliases',
                            ignore_unmapped: true,
                            query: {
                              wildcard: { 'artists.aliases.alias': { value: wildcardValue, case_insensitive: true } },
                            },
                          },
                        },
                      ]),
                ],
                minimum_should_match: 1,
              },
            },
          },
        },
        {
          nested: {
            path: 'levelCredits',
            query: {
              nested: {
                path: 'levelCredits.creator',
                query: {
                  bool: {
                    should: [
                      { wildcard: { 'levelCredits.creator.name': { value: wildcardValue, case_insensitive: true } } },
                      ...(excludeAliases
                        ? []
                        : [
                            {
                              nested: {
                                path: 'levelCredits.creator.creatorAliases',
                                query: {
                                  wildcard: {
                                    'levelCredits.creator.creatorAliases.name': {
                                      value: wildcardValue,
                                      case_insensitive: true,
                                    },
                                  },
                                },
                              },
                            },
                          ]),
                    ],
                  },
                },
              },
            },
          },
        },
        {
          nested: {
            path: 'teamObject',
            query: {
              bool: {
                should: [
                  { wildcard: { 'teamObject.name': { value: wildcardValue, case_insensitive: true } } },
                  ...(excludeAliases
                    ? []
                    : [
                        {
                          nested: {
                            path: 'teamObject.aliases',
                            query: {
                              wildcard: { 'teamObject.aliases.name': { value: wildcardValue, case_insensitive: true } },
                            },
                          },
                        },
                      ]),
                ],
                minimum_should_match: 1,
              },
            },
          },
        },
      ],
    },
  };
  return isNot ? { bool: { must_not: [query] } } : query;
}
