import type { estypes } from '@elastic/elasticsearch';
import client, { submissionQueueIndexName } from '@/config/elasticsearch.js';
import { logger } from '@/server/services/core/LoggerService.js';
import type { PendingSubmissionSort, PendingSubmissionSortDir } from '@/server/services/submissions/pendingSubmissionSort.js';
import type { PassDifficultySubtype } from '@/server/services/submissions/passDifficultySubtype.js';
import {
  parseSubmissionQueueDocId,
  type SubmissionQueueIndexDocument,
  type SubmissionQueueKind,
} from '@/server/services/elasticsearch/indexing/submissionQueueIndexDocument.js';
import {
  buildSubmissionQueueQuery,
  buildSubmissionQueueSort,
  cursorMatchesQuery,
  decodeSubmissionQueueCursor,
  encodeSubmissionQueueCursor,
  sortValueFromSource,
  type SubmissionQueueCursor,
  type SubmissionQueueSearchAfter,
} from './submissionQueueQuery.js';

export class SubmissionQueueSearchError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SubmissionQueueSearchError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export type PendingSubmissionQueueHit = {
  id: number;
  sortValue: number | null;
  sortTie: number | null;
  sortVolume: number | null;
  after: SubmissionQueueSearchAfter;
};

export type PendingSubmissionQueuePage = {
  hits: PendingSubmissionQueueHit[];
  hasMore: boolean;
  nextCursor: string | null;
};

type EsHit = {
  _id?: string | null;
  _source?: Partial<SubmissionQueueIndexDocument> | null;
  sort?: SubmissionQueueSearchAfter;
};

function asSearchAfter(value: unknown): SubmissionQueueSearchAfter | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value as SubmissionQueueSearchAfter;
}

export async function searchPendingSubmissionQueue(options: {
  kind: SubmissionQueueKind;
  sort: PendingSubmissionSort;
  dir: PendingSubmissionSortDir;
  q: string;
  hide: readonly PassDifficultySubtype[];
  cursor: SubmissionQueueCursor | null;
  limit: number;
}): Promise<PendingSubmissionQueuePage> {
  const query = buildSubmissionQueueQuery({
    kind: options.kind,
    q: options.q,
    hide: options.hide,
  });
  const sort = buildSubmissionQueueSort(options.sort, options.dir);
  const searchAfter = options.cursor
    && cursorMatchesQuery(options.cursor, {
      sort: options.sort,
      dir: options.dir,
      hide: options.hide,
      q: options.q,
    })
    ? options.cursor.after
    : undefined;

  try {
    const response = await client.search({
      index: submissionQueueIndexName,
      query,
      sort,
      size: options.limit + 1,
      track_total_hits: false,
      search_after: searchAfter,
      _source: ['id', 'createdAt', 'difficultySort', 'ratio', 'acceptedCount', 'decidedCount'],
    } as estypes.SearchRequest);
    const rawHits = Array.isArray(response.hits?.hits) ? response.hits.hits as EsHit[] : [];
    const hasMore = rawHits.length > options.limit;
    const pageHits = hasMore ? rawHits.slice(0, options.limit) : rawHits;
    const hits: PendingSubmissionQueueHit[] = [];
    for (const hit of pageHits) {
      const parsed = parseSubmissionQueueDocId(hit._id || '');
      const sourceId = Number(hit._source?.id);
      const id = parsed?.kind === options.kind ? parsed.id : sourceId;
      if (!Number.isInteger(id) || id <= 0) continue;
      const after = asSearchAfter(hit.sort);
      if (!after) continue;
      hits.push({
        id,
        sortValue: sortValueFromSource(hit._source || {}, options.sort),
        sortTie: Number.isFinite(Number(hit._source?.acceptedCount)) ? Number(hit._source?.acceptedCount) : 0,
        sortVolume: Number.isFinite(Number(hit._source?.decidedCount)) ? Number(hit._source?.decidedCount) : 0,
        after,
      });
    }
    const last = hits[hits.length - 1];
    const nextCursor = hasMore && last
      ? encodeSubmissionQueueCursor({
          v: 2,
          sort: options.sort,
          dir: options.dir,
          hide: [...options.hide],
          q: options.q,
          after: last.after,
        })
      : null;
    return { hits, hasMore, nextCursor };
  } catch (error) {
    logger.error('Pending submission queue search failed:', error);
    throw new SubmissionQueueSearchError('Failed to search pending submissions', error);
  }
}

export async function searchPendingSubmissionIds(options: {
  kind: SubmissionQueueKind;
  q: string;
  hide?: readonly PassDifficultySubtype[];
}): Promise<number[]> {
  try {
    const response = await client.search({
      index: submissionQueueIndexName,
      query: buildSubmissionQueueQuery({
        kind: options.kind,
        q: options.q,
        hide: options.hide,
      }),
      sort: buildSubmissionQueueSort('submitted', 'desc'),
      size: 10000,
      track_total_hits: false,
      _source: false,
    } as estypes.SearchRequest);
    const hits = Array.isArray(response.hits?.hits) ? response.hits.hits as EsHit[] : [];
    return hits.flatMap((hit) => {
      const parsed = parseSubmissionQueueDocId(hit._id || '');
      return parsed?.kind === options.kind ? [parsed.id] : [];
    });
  } catch (error) {
    logger.error('Pending submission id search failed:', error);
    throw new SubmissionQueueSearchError('Failed to search pending submissions', error);
  }
}

export function resolveSubmissionQueueCursor(
  raw: unknown,
  query: {
    sort: PendingSubmissionSort;
    dir: PendingSubmissionSortDir;
    hide: readonly PassDifficultySubtype[];
    q: string;
  },
): SubmissionQueueCursor | null {
  const decoded = decodeSubmissionQueueCursor(raw);
  if (!decoded) return null;
  return cursorMatchesQuery(decoded, query) ? decoded : null;
}
