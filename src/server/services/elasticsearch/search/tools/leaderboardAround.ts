import client from '@/config/elasticsearch.js';
import {
  normalizeSortValues,
  precedesFilter,
  reverseEsSort,
  sortKeysFromEsSort,
  type SortValue,
} from '@/server/services/elasticsearch/search/tools/leaderboardAroundQuery.js';

const AROUND_RADIUS = 15;

export type AroundMiss = { found: false };

export type AroundWindow = {
  found: true;
  mode: 'window';
  index: number;
  total: number;
  startIndex: number;
  hits: any[];
  hasBefore: boolean;
  hasAfter: boolean;
  beforeCursor: SortValue[] | null;
  afterCursor: SortValue[] | null;
};

export type AroundPage = {
  found: true;
  mode: 'page';
  hits: any[];
  hasMore: boolean;
  cursor: SortValue[] | null;
};

export type AroundResult = AroundMiss | AroundWindow | AroundPage;

type ScoredHit = { source: any; sort: SortValue[] };

function hitTotal(total: { value?: number } | number | undefined): number {
  if (typeof total === 'number') return total;
  return total?.value ?? 0;
}

async function searchHits(
  index: string,
  query: unknown,
  sort: unknown[],
  size: number,
  searchAfter?: SortValue[],
): Promise<ScoredHit[]> {
  const response = await client.search({
    index,
    query,
    sort,
    size,
    track_total_hits: false,
    ...(searchAfter ? { search_after: searchAfter } : {}),
  } as any);

  return (response.hits.hits ?? []).map((hit) => ({
    source: hit._source,
    sort: normalizeSortValues(hit.sort) ?? [],
  }));
}

async function countMatching(index: string, query: unknown): Promise<number> {
  const response = await client.count({ index, query } as any);
  return response.count ?? 0;
}

/**
 * Open a window centered on `anchorId`, or page away from a sort cursor.
 * `query` and `sort` must be the same ones the leaderboard list uses.
 */
export async function searchIndexAround(params: {
  index: string;
  query: unknown;
  sort: unknown[];
  anchorId: number;
  direction?: 'before' | 'after';
  cursor?: SortValue[] | null;
  limit?: number;
}): Promise<AroundResult> {
  const { index, query, sort } = params;
  const pageSize = Math.min(100, Math.max(1, Number(params.limit) || 30));

  if (params.direction) {
    const cursor = params.cursor;
    if (!cursor || cursor.length === 0) {
      throw new Error('cursor is required when paging a leaderboard window');
    }
    const pageSort = params.direction === 'before' ? reverseEsSort(sort) : sort;
    const raw = await searchHits(index, query, pageSort, pageSize + 1, cursor);
    const hasMore = raw.length > pageSize;
    const page = raw.slice(0, pageSize);
    const ordered = params.direction === 'before' ? page.reverse() : page;
    const edge = params.direction === 'before' ? ordered[0] : ordered[ordered.length - 1];
    return {
      found: true,
      mode: 'page',
      hits: ordered.map((hit) => hit.source),
      hasMore,
      cursor: edge?.sort ?? null,
    };
  }

  const anchorQuery = {
    bool: {
      filter: [query, { term: { id: params.anchorId } }],
    },
  };
  const anchorHits = await searchHits(index, anchorQuery, sort, 1);
  const anchor = anchorHits[0];
  if (!anchor || anchor.sort.length === 0) return { found: false };

  const keys = sortKeysFromEsSort(sort);
  const beforeQuery = precedesFilter(keys, anchor.sort);
  const [total, indexBefore] = await Promise.all([
    countMatching(index, query),
    beforeQuery
      ? countMatching(index, { bool: { filter: [query, beforeQuery] } })
      : Promise.resolve(0),
  ]);

  const [beforeHits, afterHits] = await Promise.all([
    indexBefore > 0
      ? searchHits(index, query, reverseEsSort(sort), Math.min(AROUND_RADIUS, indexBefore), anchor.sort)
      : Promise.resolve([] as ScoredHit[]),
    searchHits(index, query, sort, AROUND_RADIUS, anchor.sort),
  ]);

  const beforeOrdered = beforeHits.reverse();
  const hits = [...beforeOrdered, anchor, ...afterHits];
  const startIndex = indexBefore - beforeOrdered.length;
  const afterCount = Math.max(0, total - indexBefore - 1);

  return {
    found: true,
    mode: 'window',
    index: indexBefore,
    total,
    startIndex,
    hits: hits.map((hit) => hit.source),
    hasBefore: indexBefore > beforeOrdered.length,
    hasAfter: afterCount > afterHits.length,
    beforeCursor: beforeOrdered[0]?.sort ?? (indexBefore > beforeOrdered.length ? anchor.sort : null),
    afterCursor: afterHits[afterHits.length - 1]?.sort ?? (afterCount > afterHits.length ? anchor.sort : null),
  };
}
