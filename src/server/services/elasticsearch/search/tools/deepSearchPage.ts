import { setImmediate } from 'node:timers/promises';
import type { estypes } from '@elastic/elasticsearch';
import client from '@/config/elasticsearch.js';
import { logger } from '@/server/services/core/LoggerService.js';

/** Id-only pages used to walk past `from` once it exceeds Elasticsearch's result window. */
const ID_ONLY_PAGE = 1000;

/**
 * Furthest offset we will walk. Beyond this a request would issue hundreds of
 * searches; the caller gets an empty page and the real total instead.
 */
const MAX_DEEP_OFFSET = 100_000;

type EsHit = {
  _id?: string | null;
  _source?: unknown;
  sort?: Array<string | number | boolean | null>;
};

type EsSearchBody = estypes.SearchResponse<unknown>;

function totalHits(total: number | { value?: number } | null | undefined): number {
  if (typeof total === 'number') return total;
  if (total && typeof total.value === 'number') return total.value;
  return 0;
}

function withIdTiebreaker(sort: unknown[]): unknown[] {
  const hasId = sort.some((clause) => clause != null && typeof clause === 'object' && 'id' in clause);
  if (hasId) return sort;
  return [...sort, { id: 'desc' }];
}

/**
 * Page past Elasticsearch's max_result_window without downloading `_source`
 * for the skipped prefix. Skip pages are ids and sort values only; one final
 * search loads `_source` for the requested window.
 */
export async function fetchDeepSearchPage(args: {
  label: 'levels' | 'passes';
  index: string;
  query: unknown;
  sort: unknown[];
  offset: number;
  limit: number;
  trackScores?: boolean;
}): Promise<{ hits: EsHit[]; total: number }> {
  const sort = withIdTiebreaker(args.sort);
  let total = 0;

  if (args.offset > MAX_DEEP_OFFSET) {
    logger.warn('ES deep page offset exceeds walk cap', {
      label: args.label,
      offset: args.offset,
      limit: args.limit,
      cap: MAX_DEEP_OFFSET,
    });
    const counted = await client.search({
      index: args.index,
      query: args.query,
      size: 0,
      track_total_hits: true,
      _source: false,
    } as estypes.SearchRequest) as EsSearchBody;
    return { hits: [], total: totalHits(counted.hits?.total) };
  }

  let searchAfter: EsHit['sort'] | undefined;
  let skipped = 0;

  while (skipped < args.offset) {
    const pageSize = Math.min(ID_ONLY_PAGE, args.offset - skipped);
    const result = await client.search({
      index: args.index,
      query: args.query,
      sort,
      size: pageSize,
      _source: false,
      track_total_hits: skipped === 0,
      track_scores: false,
      ...(searchAfter ? { search_after: searchAfter } : {}),
    } as estypes.SearchRequest) as EsSearchBody;

    const hits = (result.hits?.hits ?? []) as EsHit[];
    if (skipped === 0) total = totalHits(result.hits?.total);
    if (hits.length === 0) return { hits: [], total };

    skipped += hits.length;
    const lastSort = hits[hits.length - 1]?.sort;
    if (!lastSort || lastSort.length === 0) {
      logger.error('ES deep page hit is missing sort values', {
        label: args.label,
        offset: args.offset,
        skipped,
      });
      return { hits: [], total };
    }
    searchAfter = lastSort;
    if (hits.length < pageSize) return { hits: [], total };
    await setImmediate();
  }

  const window = await client.search({
    index: args.index,
    query: args.query,
    sort,
    size: args.limit,
    _source: true,
    track_total_hits: false,
    track_scores: args.trackScores === true,
    search_after: searchAfter,
  } as estypes.SearchRequest) as EsSearchBody;

  return { hits: (window.hits?.hits ?? []) as EsHit[], total };
}
