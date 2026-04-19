import client, { levelIndexName } from '@/config/elasticsearch.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { convertFromPUA } from '@/misc/utils/data/searchHelpers.js';
import type { FacetQueryV1 } from '@/misc/utils/search/facetQuery.js';
import { buildFacetDomainClause, combineFacetClauses } from '@/misc/utils/search/facetQuery.js';
import {
  getDifficultyBaseScoreByDiffId,
  getDifficultySortOrderByDiffId,
  resolveCurationTypes,
  resolveDifficultyRange,
  resolveSpecialDifficulties,
  resolveTags,
} from '@/server/services/elasticsearch/search/tools/esQueryBuilder/filterResolvers.js';
import { buildPrimaryDifficultySortScript } from '@/server/services/elasticsearch/search/tools/primaryDifficultySort.js';
import { parseSearchQueryWithPUA } from '@/server/services/elasticsearch/search/tools/parseSearch.js';
import { buildAvailableDlHideClause, buildAvailableDlOnlyClause } from '@/server/services/elasticsearch/search/tools/esQueryBuilder/esQueryLevelFilters.js';
import {
  boolMust,
  boolShould,
  boolShouldOnly,
  nestedQuery,
  rangeGt,
  termField,
  termsField,
} from '@/server/services/elasticsearch/search/tools/esQueryBuilder/esQueryPrimitives.js';
import { buildFieldSearchQuery } from '@/server/services/elasticsearch/search/levels/levelFieldQuery.js';
import { shouldUseRegularSearch, isRandomSort, optimizeQueryForScroll } from '@/server/services/elasticsearch/search/tools/scrollHelpers.js';
import Difficulty from '@/models/levels/Difficulty.js';
import { Op } from 'sequelize';
import type { estypes } from '@elastic/elasticsearch';
import LevelSearchView from '@/models/levels/LevelSearchView.js';

export async function searchLevels(query: string, filters: any = {}, isSuperAdmin = false): Promise<{ hits: any[], total: number }> {
  try {
    const must: any[] = [];
    const should: any[] = [];



    // Handle text search with new parsing
    if (query) {
      if (query.length > 255) {
        query = query.substring(0, 255);
      }
      const searchGroups = parseSearchQueryWithPUA(query.trim(), false);
      if (searchGroups.length > 0) {
        const orConditions = searchGroups.map(group => {
          const andConditions = group.terms.map(term => buildFieldSearchQuery(term, filters.excludeAliases === 'true'));

          return andConditions.length === 1 ? andConditions[0] : boolMust(andConditions);
        });

        should.push(...orConditions);
      }
    }

    // Handle filters
    if (!filters.deletedFilter || filters.deletedFilter === 'hide') {
      must.push(termField('isDeleted', false));
    } else if (filters.deletedFilter === 'only' && isSuperAdmin) {
      must.push(
        boolShouldOnly([termField('isDeleted', true), termField('isHidden', true)]),
      );
    } else if (!isSuperAdmin) {
      must.push(termField('isDeleted', false));
    }

    if (filters.clearedFilter === 'hide') {
      must.push(termField('clears', 0));
    } else if (filters.clearedFilter === 'only') {
      must.push(rangeGt('clears', 0));
    }

    if (filters.availableDlFilter === 'only') {
      must.push(buildAvailableDlOnlyClause());
    } else if (filters.availableDlFilter === 'hide') {
      must.push(buildAvailableDlHideClause());
    }

    const facetQueryV1 = filters.facetQueryV1 as FacetQueryV1 | undefined;
    const hasFacetQuery =
      facetQueryV1 && (facetQueryV1.tags !== undefined || facetQueryV1.curationTypes !== undefined);

    // Handle curated types filter: isCurated only/hide
    if (filters.curatedTypesFilter === 'only') {
      must.push(termField('isCurated', true));
    } else if (filters.curatedTypesFilter === 'hide') {
      must.push(termField('isCurated', false));
    } else if (
      !hasFacetQuery &&
      filters.curatedTypesFilter &&
      filters.curatedTypesFilter !== 'show'
    ) {
      // Legacy: specific curation type names (comma-separated)
      const curationTypeNames = filters.curatedTypesFilter.split(',').map((name: string) => name.trim());
      if (curationTypeNames.length > 0) {
        const curationTypeIds = await resolveCurationTypes(curationTypeNames);
        if (curationTypeIds.length > 0) {
          must.push(
            nestedQuery(
              'curations',
              boolShould(1, curationTypeIds.map((typeId) => termField('curations.typeIds', typeId))),
            ),
          );
        }
      }
    }

    // Tags + curation type lists: facet query v1 or legacy
    if (hasFacetQuery && facetQueryV1) {
      const tagClause = facetQueryV1.tags
        ? buildFacetDomainClause(facetQueryV1.tags, 'tags', 'tags.id')
        : null;
      const curationClause = facetQueryV1.curationTypes
        ? buildFacetDomainClause(facetQueryV1.curationTypes, 'curations', 'curations.typeIds')
        : null;
      const combined = combineFacetClauses(tagClause, curationClause, facetQueryV1.combine);
      if (combined) {
        must.push(combined);
      }
    } else if (filters.tagGroups && Object.keys(filters.tagGroups).length > 0) {
      // Legacy: grouped tags — OR within groups, AND between groups
      const tagGroups = filters.tagGroups as { [groupKey: string]: number[] };
      const groupQueries = Object.values(tagGroups).map((tagIds: number[]) => {
        if (tagIds.length === 1) {
          return nestedQuery('tags', termField('tags.id', tagIds[0]));
        }

        return nestedQuery(
          'tags',
          boolShould(1, tagIds.map((tagId) => termField('tags.id', tagId))),
        );
      });

      must.push(boolMust(groupQueries));
    } else if (filters.tagsFilter && filters.tagsFilter !== 'show') {
      // Legacy: comma-separated tag names — ALL selected tags (AND)
      const tagNames = filters.tagsFilter.split(',').map((name: string) => name.trim());
      if (tagNames.length > 0) {
        const tagIds = await resolveTags(tagNames);
        if (tagIds.length > 0) {
          const tagQueries = tagIds.map((tagId) => nestedQuery('tags', termField('tags.id', tagId)));

          must.push(boolMust(tagQueries));
        }
      }
    }

    // Handle hideVerified filter
    if (filters.hideVerified === 'true') {
      must.push(
        boolMust([
          nestedQuery('levelCredits', boolMust([termField('levelCredits.isVerified', false)])),
        ]),
      );
    }

    // Handle songId filter
    if (filters.songId) {
      const songIdValue = parseInt(filters.songId);
      if (!isNaN(songIdValue) && songIdValue > 0) {
        must.push(termField('songId', songIdValue));
      }
    }

    if (filters.creatorId && !isSuperAdmin) {
      const creatorNested = nestedQuery(
        'levelCredits',
        boolShouldOnly([termField('levelCredits.creatorId', filters.creatorId)]),
      );
      if (filters.deletedFilter === 'show') {
        should.push(boolShould(1, [creatorNested, termField('isHidden', false)]));
      } else if (filters.deletedFilter === 'only') {
        should.push(boolMust([creatorNested, termField('isHidden', true)]));
      } else {
        must.push(termField('isHidden', false));
      }
    } else if (isSuperAdmin) {
      if (filters.deletedFilter === 'hide') {
        must.push(termField('isHidden', false));
      }
    } else {
      must.push(termField('isHidden', false));
    }

    // Handle liked levels filter
    if (filters.likedLevelIds?.length > 0) {
      must.push(termsField('id', filters.likedLevelIds));
    }

    // Handle difficulty filters
    if (filters.pguRange || filters.specialDifficulties) {
      const difficultyConditions = [];

      // Resolve PGU range to IDs
      if (filters.pguRange) {
        const { from, to } = filters.pguRange;
        const pguIds = await resolveDifficultyRange(from, to);
        if (pguIds.length > 0) {
          difficultyConditions.push(termsField('diffId', pguIds));
        }
      }

      // Resolve special difficulties to IDs
      if (filters.specialDifficulties?.length > 0) {
        const specialIds = await resolveSpecialDifficulties(filters.specialDifficulties);
        if (specialIds.length > 0) {
          difficultyConditions.push(termsField('diffId', specialIds));
        }
      }

      if (difficultyConditions.length > 0) {
        must.push(boolShould(1, difficultyConditions));
      }
    }

    const searchQuery = {
      bool: {
        must,
        ...(should.length > 0 && { should, minimum_should_match: 1 })
      }
    };

    // Validate and limit offset to prevent integer overflow
    const maxOffset = 2147483647; // Maximum 32-bit integer
    const maxResultWindow = 10000; // Elasticsearch's default max_result_window
    const offset = Math.min(Math.max(0, Number(filters.offset) || 0), maxOffset);
    const limit = Math.min(100, Math.max(1, Number(filters.limit) || 30));

    // If we need to access results beyond maxResultWindow, use scroll API
    if (offset + limit > maxResultWindow) {
      return searchLevelsWithScroll(searchQuery, filters.sort, offset, limit);
    }

    // Regular search for results within maxResultWindow
    const response = await client.search({
      index: levelIndexName,
      query: searchQuery,
      sort: await getLevelSortOptions(filters.sort),
      from: offset,
      size: limit,
      track_total_hits: true, // Ensure accurate total count
      track_scores: true // Keep scores for sorting
    }) as estypes.SearchResponse<LevelSearchView>;

    let diffs: Difficulty[] = [];
    if (response.hits.hits.length > 0) {
    diffs = await Difficulty.findAll({
      where: {
        id: { [Op.in]: response.hits.hits.map((hit) => hit._source!.diffId) }
      }
    });
    }

    // Convert PUA characters back to original special characters in the results
    const hits = response.hits.hits.map(hit => {
      const source = hit._source as Record<string, any>;
      return convertLevelSearchHit(source, diffs);
    });

    return {
      hits,
      total: response.hits.total ? (typeof response.hits.total === 'number' ? response.hits.total : response.hits.total.value) : 0
    };
  } catch (error) {
    logger.error('Error searching levels:', error);
    throw error;
  }
}

async function searchLevelsWithScroll(
  searchQuery: any,
  sort: string | undefined,
  offset: number,
  limit: number
): Promise<{ hits: any[], total: number }> {
  try {
    // Get sort options
    const sortOptions = await getLevelSortOptions(sort);

    // Check if we should use regular search instead of scroll
    if (shouldUseRegularSearch(sortOptions)) {
      logger.warn('Using regular search instead of scroll due to sort type');
      return searchLevelsWithRegularSearch(searchQuery, sortOptions, offset, limit);
    }

    // Initialize scroll with optimized settings
    const initialResponse = await client.search({
      index: levelIndexName,
      query: optimizeQueryForScroll(searchQuery),
      sort: sortOptions,
      size: Math.min(1000, offset + limit),
      scroll: '1m',
      track_total_hits: true, // Ensure accurate total count
      track_scores: true // Keep scores for sorting
    });

    const scrollId = initialResponse._scroll_id;
    let hits: Record<string, any>[] = [];
    const total = initialResponse.hits.total ?
      (typeof initialResponse.hits.total === 'number' ? initialResponse.hits.total : initialResponse.hits.total.value) : 0;

    try {
      // Process initial batch (sources only; difficulties loaded after final slice)
      hits = initialResponse.hits.hits.map(hit => hit._source as Record<string, any>);

      // If we need more results, continue scrolling
      let scrollCount = 0;
      const maxScrolls = Math.ceil((offset + limit) / 1000) + 1; // Add 1 for safety

      while (hits.length < offset + limit && scrollCount < maxScrolls) {
        const scrollResponse = await client.scroll({
          scroll_id: scrollId,
          scroll: '1m'
        });

        if (scrollResponse.hits.hits.length === 0) {
          break; // No more results
        }

        const newHits = scrollResponse.hits.hits.map(hit => hit._source as Record<string, any>);

        hits = hits.concat(newHits);
        scrollCount++;

        // Log progress for long-running scrolls
        if (scrollCount % 5 === 0) {
          logger.debug(`Scroll progress: ${hits.length} results fetched after ${scrollCount} scrolls`);
        }
      }

      // Slice the results to get the requested range
      const sources = hits.slice(offset, offset + limit);

      let diffs: Difficulty[] = [];
      if (sources.length > 0) {
        diffs = await Difficulty.findAll({
          where: {
            id: { [Op.in]: sources.map((s) => s.diffId) },
          },
        });
      }

      const convertedHits = sources.map((source) => convertLevelSearchHit(source, diffs));

      return { hits: convertedHits, total };
    } finally {
      // Clean up scroll context
      if (scrollId) {
        await client.clearScroll({ scroll_id: scrollId });
      }
    }
  } catch (error) {
    logger.error('Error in scroll search:', error);
    throw error;
  }
}

async function searchLevelsWithRegularSearch(
  searchQuery: any,
  sortOptions: any[],
  offset: number,
  limit: number
): Promise<{ hits: any[], total: number }> {
  try {
    // For random sorting, we'll use a different approach
    if (isRandomSort(sortOptions)) {
      return searchLevelsWithRandomSort(searchQuery, offset, limit);
    }

    // For other cases, use regular search with increased max_result_window
    const response = await client.search({
      index: levelIndexName,
      query: searchQuery,
      sort: sortOptions,
      from: offset,
      size: limit,
      track_total_hits: true
    }) as estypes.SearchResponse<LevelSearchView>;

    let diffs: Difficulty[] = [];
    if (response.hits.hits.length > 0) {
      diffs = await Difficulty.findAll({
        where: {
          id: { [Op.in]: response.hits.hits.map((hit) => hit._source!.diffId) },
        },
      });
    }

    const hits = response.hits.hits.map((hit) => {
      const source = hit._source as Record<string, any>;
      return convertLevelSearchHit(source, diffs);
    });

    return {
      hits,
      total: response.hits.total ? (typeof response.hits.total === 'number' ? response.hits.total : response.hits.total.value) : 0
    };
  } catch (error) {
    logger.error('Error in regular search:', error);
    throw error;
  }
}

async function searchLevelsWithRandomSort(
  searchQuery: any,
  offset: number,
  limit: number
): Promise<{ hits: any[], total: number }> {
  try {
    // For random sorting, we'll use a different approach:
    // 1. Get total count
    const countResponse = await client.count({
      index: levelIndexName,
      query: searchQuery
    });

    const total = countResponse.count;

    // 2. Generate random offsets
    const randomOffsets = new Set<number>();
    while (randomOffsets.size < limit) {
      const randomOffset = Math.floor(Math.random() * total);
      randomOffsets.add(randomOffset);
    }

    // 3. Fetch results for each random offset
    const sources = await Promise.all(
      Array.from(randomOffsets).map(async (randomOffset) => {
        const response = await client.search({
          index: levelIndexName,
          query: searchQuery,
          from: randomOffset,
          size: 1
        });

        if (response.hits.hits.length > 0) {
          return response.hits.hits[0]._source as Record<string, any>;
        }
        return null;
      })
    );

    const nonNullSources = sources.filter((s): s is Record<string, any> => s !== null);

    let diffs: Difficulty[] = [];
    if (nonNullSources.length > 0) {
      diffs = await Difficulty.findAll({
        where: {
          id: { [Op.in]: nonNullSources.map((s) => s.diffId) },
        },
      });
    }

    const hits = nonNullSources.map((source) => convertLevelSearchHit(source, diffs));

    return {
      hits,
      total
    };
  } catch (error) {
    logger.error('Error in random sort search:', error);
    throw error;
  }
}

function convertLevelSearchHit(source: Record<string, any>, diffs: Difficulty[]): any {
  return {
    ...source,

    difficulty: diffs.find(diff => diff.id === source.diffId),

    song: convertFromPUA(source.song as string),
    artist: convertFromPUA(source.artist as string),
    creator: convertFromPUA(source.creator as string),
    suffix: source.suffix ? convertFromPUA(source.suffix as string) : null,
    team: convertFromPUA(source.team as string),
    videoLink: convertFromPUA(source.videoLink as string),
    dlLink: convertFromPUA(source.dlLink as string),
    legacyDllink: convertFromPUA(source.legacyDllink as string),
    aliases: source.aliases?.map((alias: Record<string, any>) => ({
      ...alias,
      originalValue: convertFromPUA(alias.originalValue as string),
      alias: convertFromPUA(alias.alias as string)
    })),
    songObject: source.songObject ? {
      ...source.songObject,
      name: convertFromPUA(source.songObject.name as string),
      aliases: source.songObject.aliases?.map((alias: Record<string, any>) => ({
        ...alias,
        alias: convertFromPUA(alias.alias as string)
      }))
    } : null,
    artists: source.artists?.map((artist: Record<string, any>) => ({
      ...artist,
      name: convertFromPUA(artist.name as string),
      aliases: artist.aliases?.map((alias: Record<string, any>) => ({
        ...alias,
        alias: convertFromPUA(alias.alias as string)
      })) || []
    })),
    levelCredits: source.levelCredits?.map((credit: Record<string, any>) => ({
      ...credit,
      creator: credit.creator ? {
        ...credit.creator,
        name: convertFromPUA(credit.creator.name as string),
        creatorAliases: credit.creator.creatorAliases?.map((alias: Record<string, any>) => ({
          ...alias,
          name: convertFromPUA(alias.name as string)
        }))
      } : null
    })),
    teamObject: source.teamObject ? {
      ...source.teamObject,
      name: convertFromPUA(source.teamObject.name as string),
      aliases: source.teamObject.aliases?.map((alias: Record<string, any>) => ({
        ...alias,
        name: convertFromPUA(alias.name as string)
      }))
    } : null,
  };
}

/**
 * Secondary bucket within the same primary difficulty (sort asc: lower first).
 * 0 = community average harder than the level's difficulty (comparison only when avg exists in map).
 * 1 = community average at or below the level's difficulty.
 * 2 = missing averageDifficultyId, unknown average id, or unknown level difficulty — lowest priority.
 */
const DIFF_AVG_TIER_SCRIPT = `
  if (doc['diffId'].size() == 0) {
    return 2;
  }

  int levelDifficultyId = (int) doc['diffId'].value;
  String levelDifficultyIdKey = Integer.toString(levelDifficultyId);
  if (!params.difficultySortOrderById.containsKey(levelDifficultyIdKey)) {
    return 2;
  }

  int levelDifficultySortOrder = params.difficultySortOrderById.get(levelDifficultyIdKey);
  if (doc['rating.averageDifficultyId'].size() == 0) {
    return 2;
  }

  int communityAverageDifficultyId = (int) doc['rating.averageDifficultyId'].value;
  String communityAverageDifficultyIdKey = Integer.toString(communityAverageDifficultyId);
  if (!params.difficultySortOrderById.containsKey(communityAverageDifficultyIdKey)) {
    return 2;
  }

  int communityAverageDifficultySortOrder = params.difficultySortOrderById.get(communityAverageDifficultyIdKey);
  if (communityAverageDifficultySortOrder > levelDifficultySortOrder) {
    return 0;
  }

  if (communityAverageDifficultyId == levelDifficultyId) {
    return 2;
  }


  return 1;
`.trim();

/**
 * Within tier 0/1: sort by community average difficulty sort order (desc = harder first).
 * Tier 2 (missing/unknown avg): constant so ties break on id only.
 */
const DIFF_AVG_SECONDARY_SCRIPT = `
  if (doc['rating.averageDifficultyId'].size() == 0) {
    return params.missingAverageDifficultySortKey;
  }
  int communityAverageDifficultyId = (int) doc['rating.averageDifficultyId'].value;
  String communityAverageDifficultyIdKey = Integer.toString(communityAverageDifficultyId);
  if (!params.difficultySortOrderById.containsKey(communityAverageDifficultyIdKey)) {
    return params.unknownAverageDifficultySortKey;
  }
  return params.difficultySortOrderById.get(communityAverageDifficultyIdKey);
`.trim();

/**
 * Effective base score: level.baseScore || difficulty.baseScore || 0 (JS truthiness on level.baseScore).
 * difficulty.baseScore comes from params.difficultyBaseScoreByDiffId (DB truth, non-zero entries only).
 */
const BASESCORE_SORT_SCRIPT = `
  if (doc['baseScore'].size() != 0) {
    double levelBase = doc['baseScore'].value;
    if (levelBase != 0) {
      return levelBase;
    }
  }
  if (doc['diffId'].size() == 0) {
    return 0;
  }
  String diffIdKey = Integer.toString((int) doc['diffId'].value);
  if (params.difficultyBaseScoreById.containsKey(diffIdKey)) {
    return params.difficultyBaseScoreById.get(diffIdKey);
  }
  return 0;
`.trim();

async function getLevelSortOptions(sort?: string): Promise<any[]> {
  const direction = sort?.split('_').pop() === 'ASC' ? 'asc' : 'desc';
  const sortKey = sort?.split('_').slice(0, -1).join('_');

  switch (sortKey) {
    case 'RECENT':
      return [{ id: direction }];
    case 'DIFF': {
      const difficultySortOrderById = await getDifficultySortOrderByDiffId();
      const missingAverageDifficultySortKey = 0;
      const unknownAverageDifficultySortKey = -2147483648;
      return [
        buildPrimaryDifficultySortScript('diffId', direction, difficultySortOrderById),
        {
          _script: {
            type: 'number',
            order: 'asc',
            script: {
              source: DIFF_AVG_TIER_SCRIPT,
              params: { difficultySortOrderById },
            },
          },
        },
        {
          _script: {
            type: 'number',
            order: 'desc',
            script: {
              source: DIFF_AVG_SECONDARY_SCRIPT,
              params: {
                difficultySortOrderById,
                missingAverageDifficultySortKey,
                unknownAverageDifficultySortKey,
              },
            },
          },
        },
        { id: 'desc' },
      ];
    }
    case 'CLEARS':
      return [{ clears: direction }, { id: 'desc' }];
    case 'BASESCORE': {
      const [difficultyBaseScoreById, difficultySortOrderById] = await Promise.all([
        getDifficultyBaseScoreByDiffId(),
        getDifficultySortOrderByDiffId(),
      ]);
      return [
        {
          _script: {
            type: 'number',
            order: direction,
            script: {
              source: BASESCORE_SORT_SCRIPT,
              params: { difficultyBaseScoreById },
            },
          },
        },
        buildPrimaryDifficultySortScript('diffId', direction, difficultySortOrderById),
        { id: 'desc' },
      ];
    }
    case 'LIKES':
      return [{ likes: direction }, { id: 'desc' }];
    case 'BPM':
      return [{ bpm: { order: direction, missing: '_last' } }, { id: 'desc' }];
    case 'TILES':
      return [{ tilecount: { order: direction, missing: '_last' } }, { id: 'desc' }];
    case 'TIME':
      return [{ levelLengthInMs: { order: direction, missing: '_last' } }, { id: 'desc' }];
    case 'RANDOM':
      return [{ _script: { script: 'Math.random()', type: 'number' } }];
    default:
      return [{ id: 'desc' }];
  }
}


