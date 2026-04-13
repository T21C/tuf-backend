import client, { passIndexName } from '@/config/elasticsearch.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { Op } from 'sequelize';
import Difficulty from '@/models/levels/Difficulty.js';
import { convertFromPUA } from '@/misc/utils/data/searchHelpers.js';
import { parseSearchQueryWithPUA } from '@/server/services/elasticsearch/search/parseSearch.js';
import {
  boolMust,
  boolShould,
  boolShouldOnly,
  rangeGt,
  termField,
  termsField,
} from '@/server/services/elasticsearch/search/esQueryPrimitives.js';
import { buildPassFieldSearchQuery } from '@/server/services/elasticsearch/search/passFieldQuery.js';
import { shouldUseRegularSearch, isRandomSort, optimizeQueryForScroll } from '@/server/services/elasticsearch/search/scrollHelpers.js';

export async function searchPasses(query: string, filters: any = {}, userPlayerId?: number, isSuperAdmin = false): Promise<{ hits: any[], total: number }> {
  try {
    const must: any[] = [];
    const should: any[] = [];



    // Handle text search with new parsing
    if (query) {
      if (query.length > 255) {
        query = query.substring(0, 255);
      }
      const searchGroups = parseSearchQueryWithPUA(query.trim(), true);
      if (searchGroups.length > 0) {
        const orConditions = searchGroups.map(group => {
          const andConditions = group.terms.map(term => buildPassFieldSearchQuery(term));

          return andConditions.length === 1 ? andConditions[0] : boolMust(andConditions);
        });

        should.push(...orConditions);
      }
    }

    // Handle filters
    if (!filters.deletedFilter || filters.deletedFilter === 'hide') {
      must.push(termField('isDeleted', false));
      must.push(termField('level.isHidden', false));
      must.push(termField('level.isDeleted', false));
      must.push(termField('player.isBanned', false));

      if (userPlayerId !== undefined) {
        must.push(
          boolShould(1, [
            termField('isHidden', false),
            boolMust([termField('isHidden', true), termField('player.id', userPlayerId)]),
          ]),
        );
      } else {
        must.push(termField('isHidden', false));
      }
    } else if (filters.deletedFilter === 'only' && isSuperAdmin) {
      must.push(
        boolShouldOnly([
          termField('isDeleted', true),
          termField('level.isHidden', true),
          termField('level.isDeleted', true),
          termField('player.isBanned', true),
        ]),
      );
    }

    // Handle key flag filter
    if (filters.keyFlag) {
      switch (filters.keyFlag) {
        case '12k':
          must.push(termField('is12K', true));
          break;
        case '16k':
          must.push(termField('is16K', true));
          break;
      }
    }

    const sortType = filters.sort?.split('_').slice(0, -1).join('_');
    if (sortType === 'SPEED') {
      must.push(rangeGt('speed', 1));
    }

    // Handle difficulty filters
    if (filters.minDiff || filters.maxDiff || filters.specialDifficulties) {
      const difficultyConditions = [];

      // Handle PGU range
      if (filters.minDiff || filters.maxDiff) {
        const [fromDiff, toDiff] = await Promise.all([
          filters.minDiff
            ? Difficulty.findOne({
                where: { name: filters.minDiff, type: 'PGU' },
                attributes: ['id', 'sortOrder'],
              })
            : null,
          filters.maxDiff
            ? Difficulty.findOne({
                where: { name: filters.maxDiff, type: 'PGU' },
                attributes: ['id', 'sortOrder'],
              })
            : null,
        ]);

        if (fromDiff || toDiff) {
          const pguDifficulties = await Difficulty.findAll({
            where: {
              type: 'PGU',
              sortOrder: {
                ...(fromDiff && { [Op.gte]: fromDiff.sortOrder }),
                ...(toDiff && { [Op.lte]: toDiff.sortOrder }),
              },
            },
            attributes: ['id'],
          });

          if (pguDifficulties.length > 0) {
            difficultyConditions.push(termsField('level.diffId', pguDifficulties.map((d) => d.id)));
          }
        }
      }

      // Handle special difficulties
      if (filters.specialDifficulties?.length > 0) {
        const specialDiffs = await Difficulty.findAll({
          where: {
            name: { [Op.in]: filters.specialDifficulties },
            type: 'SPECIAL',
          },
          attributes: ['id'],
        });

        if (specialDiffs.length > 0) {
          difficultyConditions.push(termsField('level.diffId', specialDiffs.map((d) => d.id)));
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
      return searchPassesWithScroll(searchQuery, filters.sort, offset, limit);
    }

    // Regular search for results within maxResultWindow
    const response = await client.search({
      index: passIndexName,
      query: searchQuery,
      sort: getPassSortOptions(filters.sort),
      from: offset,
      size: limit,
      track_total_hits: true
    });

    // Convert PUA characters back to original special characters in the results
    const hits = response.hits.hits.map(hit => {
      const source = hit._source as Record<string, any>;
      return convertPassSearchHit(source);
    });

    return {
      hits,
      total: response.hits.total ? (typeof response.hits.total === 'number' ? response.hits.total : response.hits.total.value) : 0
    };
  } catch (error) {
    logger.error('Error searching passes:', error);
    throw error;
  }
}

async function searchPassesWithScroll(
  searchQuery: any,
  sort: string | undefined,
  offset: number,
  limit: number
): Promise<{ hits: any[], total: number }> {
  try {
    // Get sort options
    const sortOptions = getPassSortOptions(sort);

    // Check if we should use regular search instead of scroll
    if (shouldUseRegularSearch(sortOptions)) {
      logger.warn('Using regular search instead of scroll due to sort type');
      return searchPassesWithRegularSearch(searchQuery, sortOptions, offset, limit);
    }

    // Initialize scroll with optimized settings
    const initialResponse = await client.search({
      index: passIndexName,
      query: optimizeQueryForScroll(searchQuery),
      sort: sortOptions,
      size: Math.min(1000, offset + limit),
      scroll: '1m',
      track_total_hits: true,
      track_scores: true
    });

    const scrollId = initialResponse._scroll_id;
    let hits: any[] = [];
    const total = initialResponse.hits.total ?
      (typeof initialResponse.hits.total === 'number' ? initialResponse.hits.total : initialResponse.hits.total.value) : 0;

    try {
      // Process initial batch
      hits = initialResponse.hits.hits.map(hit => {
        const source = hit._source as Record<string, any>;
        return convertPassSearchHit(source);
      });

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

        const newHits = scrollResponse.hits.hits.map(hit => {
          const source = hit._source as Record<string, any>;
          return convertPassSearchHit(source);
        });

        hits = hits.concat(newHits);
        scrollCount++;

        // Log progress for long-running scrolls
        if (scrollCount % 5 === 0) {
          logger.debug(`Scroll progress: ${hits.length} results fetched after ${scrollCount} scrolls`);
        }
      }

      // Slice the results to get the requested range
      hits = hits.slice(offset, offset + limit);

      return { hits, total };
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

async function searchPassesWithRegularSearch(
  searchQuery: any,
  sortOptions: any[],
  offset: number,
  limit: number
): Promise<{ hits: any[], total: number }> {
  try {
    // For random sorting, we'll use a different approach
    if (isRandomSort(sortOptions)) {
      return searchPassesWithRandomSort(searchQuery, offset, limit);
    }

    // For other cases, use regular search with increased max_result_window
    const response = await client.search({
      index: passIndexName,
      query: searchQuery,
      sort: sortOptions,
      from: offset,
      size: limit,
      track_total_hits: true
    });

    const hits = response.hits.hits.map(hit => {
      const source = hit._source as Record<string, any>;
      return convertPassSearchHit(source);
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

async function searchPassesWithRandomSort(
  searchQuery: any,
  offset: number,
  limit: number
): Promise<{ hits: any[], total: number }> {
  try {
    // For random sorting, we'll use a different approach:
    // 1. Get total count
    const countResponse = await client.count({
      index: passIndexName,
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
    const hits = await Promise.all(
      Array.from(randomOffsets).map(async (randomOffset) => {
        const response = await client.search({
          index: passIndexName,
          query: searchQuery,
          from: randomOffset,
          size: 1
        });

        if (response.hits.hits.length > 0) {
          const source = response.hits.hits[0]._source as Record<string, any>;
          return convertPassSearchHit(source);
        }
        return null;
      })
    );

    return {
      hits: hits.filter(hit => hit !== null),
      total
    };
  } catch (error) {
    logger.error('Error in random sort search:', error);
    throw error;
  }
}

function convertPassSearchHit(source: Record<string, any>): any {
  return {
    ...source,
    vidTitle: convertFromPUA(source.vidTitle as string),
    videoLink: convertFromPUA(source.videoLink as string),
    player: source.player ? {
      ...source.player,
      name: convertFromPUA(source.player.name as string)
    } : null,
    level: source.level ? {
      ...source.level,
      song: convertFromPUA(source.level.song as string),
      artist: convertFromPUA(source.level.artist as string)
    } : null
  };
}

function getPassSortOptions(sort?: string): any[] {
  const direction = sort?.split('_').pop() === 'ASC' ? 'asc' : 'desc';

  switch (sort?.split('_').slice(0, -1).join('_')) {
    case 'RECENT':
      return [{ vidUploadTime: direction }];
    case 'SCORE':
      return [{ scoreV2: direction }, { id: 'desc' }];
    case 'XACC':
      return [{ accuracy: direction }, { scoreV2: 'desc' }, { id: 'desc' }];
    case 'SPEED':
      return [{ speed: direction }, { speed: 'desc' }, { id: 'desc' }];
    case 'DIFF':
      return [{ 'level.difficulty.sortOrder': direction }, { scoreV2: 'desc' }, { id: 'desc' }];
    case 'RANDOM':
      return [{ _script: { script: 'Math.random()', type: 'number' } }];
    default:
      return [{ scoreV2: 'desc' }, { id: 'desc' }];
  }
}
