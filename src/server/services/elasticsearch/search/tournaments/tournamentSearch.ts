import client, {tournamentIndexName} from '@/config/elasticsearch.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {
  buildTournamentSearchQuery,
  buildTournamentSearchSort,
  parseTournamentLimit,
  parseTournamentOffset,
  type TournamentSearchOptions,
} from './tournamentSearchQuery.js';

export type {TournamentSearchOptions};

export type TournamentSearchResult = {
  total: number;
  ids: number[];
  offset: number;
  limit: number;
};

export async function searchTournaments(
  options: TournamentSearchOptions = {},
): Promise<TournamentSearchResult> {
  const offset = parseTournamentOffset(options.offset);
  const limit = parseTournamentLimit(options.limit);
  const query = buildTournamentSearchQuery({
    q: options.q?.trim() || undefined,
    status: options.status,
    includeHidden: options.includeHidden,
    includeDraft: options.includeDraft,
  });
  const sort = buildTournamentSearchSort();

  try {
    const response = await client.search({
      index: tournamentIndexName,
      from: offset,
      size: limit,
      query,
      sort,
      _source: false,
      track_total_hits: true,
    });
    const hits = Array.isArray(response.hits?.hits) ? response.hits.hits : [];
    const totalRaw = response.hits?.total;
    const total =
      typeof totalRaw === 'number'
        ? totalRaw
        : typeof totalRaw?.value === 'number'
          ? totalRaw.value
          : hits.length;
    const ids = hits
      .map(hit => Number(hit._id))
      .filter(id => Number.isFinite(id) && id > 0);
    return {total, ids, offset, limit};
  } catch (error) {
    logger.error('Tournament search failed:', error);
    throw error;
  }
}
