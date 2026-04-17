import client, { playerIndexName } from '@/config/elasticsearch.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { rangeOnField, termField } from '@/server/services/elasticsearch/search/tools/esQueryBuilder/esQueryPrimitives.js';

export interface PlayerSearchOptions {
  /** Plain text search — matches player name, user.username, user.nickname. */
  text?: string;
  /** Raw query string; if it starts with `#` treated as discord provider id, `@` as discord username. */
  rawQuery?: string;
  /** `show` keeps banned, `hide` removes them, `only` returns only banned. */
  showBanned?: 'show' | 'hide' | 'only';
  /** Range filters (numeric metrics + `country` exact match). */
  filters?: Record<string, [number, number] | string>;
  /** Sort key (see mapping below). */
  sortBy?: string;
  order?: 'asc' | 'desc';
  offset?: number;
  limit?: number;
  /** Requires `totalPasses > 0` (default leaderboard behavior when no query). */
  requireHasPasses?: boolean;
}

export interface PlayerSearchResult {
  total: number;
  hits: any[];
  offset: number;
  limit: number;
}

const PLAYER_SORT_FIELD_MAP: Record<string, string> = {
  rankedScore: 'rankedScore',
  generalScore: 'generalScore',
  ppScore: 'ppScore',
  wfScore: 'wfScore',
  score12K: 'score12K',
  averageXacc: 'averageXacc',
  totalPasses: 'totalPasses',
  universalPassCount: 'universalPassCount',
  worldsFirstCount: 'worldsFirstCount',
  topDiff: 'topDiffSortOrder',
  top12kDiff: 'top12kDiffSortOrder',
  topDiffId: 'topDiffSortOrder',
  top12kDiffId: 'top12kDiffSortOrder',
  name: 'name.lower',
  id: 'id',
};

const NUMERIC_FILTER_FIELDS = new Set([
  'rankedScore',
  'generalScore',
  'ppScore',
  'wfScore',
  'score12K',
  'averageXacc',
  'totalPasses',
  'universalPassCount',
  'worldsFirstCount',
]);

function parseSpecialPrefix(raw?: string): {
  cleaned?: string;
  discordProviderId?: string;
  discordUsername?: string;
} {
  if (!raw) return {};
  const q = raw.trim();
  if (q.startsWith('#')) {
    const idStr = q.slice(1);
    if (/^[0-9]+$/.test(idStr)) {
      return { discordProviderId: idStr };
    }
    return {};
  }
  if (q.startsWith('@')) {
    const uname = q.slice(1);
    if (uname.length > 0) {
      return { discordUsername: uname };
    }
    return {};
  }
  return { cleaned: q };
}

function escapeWildcard(value: string): string {
  return value.replace(/[\\*?]/g, (ch) => `\\${ch}`);
}

function buildTextShould(text: string): any[] {
  const lc = text.toLowerCase();
  const wildcardValue = `*${escapeWildcard(lc)}*`;
  const prefixValue = `${escapeWildcard(lc)}*`;

  return [
    // Exact (highest boost)
    { term: { 'name.lower': { value: lc, boost: 10, case_insensitive: true } } },
    { term: { 'user.username.lower': { value: lc, boost: 9, case_insensitive: true } } },
    // Prefix match
    { wildcard: { 'name.lower': { value: prefixValue, boost: 5, case_insensitive: true } } },
    { wildcard: { 'user.username.lower': { value: prefixValue, boost: 5, case_insensitive: true } } },
    // Substring match
    { wildcard: { 'name.lower': { value: wildcardValue, boost: 2, case_insensitive: true } } },
    { wildcard: { 'user.username.lower': { value: wildcardValue, boost: 2, case_insensitive: true } } },
    // Nickname substring (no prefix boost — display name)
    { wildcard: { 'user.nickname': { value: wildcardValue, boost: 1, case_insensitive: true } } },
    // Fuzzy/text fields fall back via match
    { match: { name: { query: text, boost: 1 } } },
    { match: { 'user.username': { query: text, boost: 1 } } },
  ];
}

function buildPlayerQuery(options: PlayerSearchOptions): any {
  const must: any[] = [];
  const should: any[] = [];
  const filter: any[] = [];

  const {
    cleaned,
    discordProviderId,
    discordUsername,
  } = parseSpecialPrefix(options.rawQuery ?? options.text);

  if (discordProviderId) {
    must.push(termField('discord.providerId', discordProviderId));
  } else if (discordUsername) {
    must.push(termField('discord.username.lower', discordUsername.toLowerCase(), true));
  } else {
    const text = cleaned ?? options.text;
    if (text && text.trim().length > 0) {
      should.push(...buildTextShould(text.trim()));
    }
  }

  const showBanned = options.showBanned ?? 'show';
  if (showBanned === 'hide') {
    filter.push(termField('isBanned', false));
  } else if (showBanned === 'only') {
    filter.push(termField('isBanned', true));
  }

  if (options.requireHasPasses) {
    filter.push({ range: { totalPasses: { gt: 0 } } });
  }

  if (options.filters) {
    for (const [key, value] of Object.entries(options.filters)) {
      if (key === 'country' && typeof value === 'string' && value.length > 0) {
        filter.push(termField('country', value));
        continue;
      }
      if (NUMERIC_FILTER_FIELDS.has(key) && Array.isArray(value) && value.length === 2) {
        const [min, max] = value;
        if (Number.isFinite(min) && Number.isFinite(max)) {
          filter.push(rangeOnField(key, { gte: Number(min), lte: Number(max) }));
        }
      }
    }
  }

  const query: any = { bool: {} };
  if (must.length > 0) query.bool.must = must;
  if (filter.length > 0) query.bool.filter = filter;
  if (should.length > 0) {
    query.bool.should = should;
    query.bool.minimum_should_match = 1;
  }
  if (!query.bool.must && !query.bool.should && !query.bool.filter) {
    query.bool.must = [{ match_all: {} }];
  }
  return query;
}

/**
 * Sort keys whose values are chunky enums rather than continuous numbers and therefore
 * produce massive ties (every player at the same top difficulty collapses together).
 * We tiebreak these with `rankedScore desc` so the ordering inside a tier reflects
 * leaderboard strength instead of insertion order.
 */
const TIEBREAK_ON_RANKED_SCORE = new Set(['topDiffSortOrder', 'top12kDiffSortOrder']);

function buildPlayerSort(options: PlayerSearchOptions): any[] {
  const order = options.order === 'asc' ? 'asc' : 'desc';
  const mapped = options.sortBy ? PLAYER_SORT_FIELD_MAP[options.sortBy] : undefined;

  if (!mapped) {
    // No sort: return by score (text search relevance) then id
    return [{ _score: 'desc' }, { id: 'desc' }];
  }

  const sort: any[] = [{ [mapped]: order }];
  if (TIEBREAK_ON_RANKED_SCORE.has(mapped) && mapped !== 'rankedScore') {
    sort.push({ rankedScore: 'desc' });
  }
  sort.push({ id: 'desc' });
  return sort;
}

export async function searchPlayers(options: PlayerSearchOptions): Promise<PlayerSearchResult> {
  try {
    const offset = Math.max(0, Number(options.offset) || 0);
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 30));

    const query = buildPlayerQuery(options);
    const sort = buildPlayerSort(options);

    const response = await client.search({
      index: playerIndexName,
      query,
      sort,
      from: offset,
      size: limit,
      track_total_hits: true,
    });

    const hits = response.hits.hits.map((h) => h._source as any);
    const total = response.hits.total
      ? typeof response.hits.total === 'number'
        ? response.hits.total
        : response.hits.total.value
      : 0;

    return { hits, total, offset, limit };
  } catch (error) {
    logger.error('Error searching players:', error);
    throw error;
  }
}

export interface PlayerRanks {
  rankedScoreRank: number;
  generalScoreRank: number;
  ppScoreRank: number;
  wfScoreRank: number;
  score12KRank: number;
}

/**
 * Compute the player's rank on each scalar metric using 5 parallel ES `count` queries.
 * Banned players return -1 on every rank (matches legacy semantics).
 */
export async function getPlayerRanks(doc: {
  isBanned?: boolean;
  rankedScore?: number;
  generalScore?: number;
  ppScore?: number;
  wfScore?: number;
  score12K?: number;
}): Promise<PlayerRanks> {
  if (doc?.isBanned) {
    return {
      rankedScoreRank: -1,
      generalScoreRank: -1,
      ppScoreRank: -1,
      wfScoreRank: -1,
      score12KRank: -1,
    };
  }

  const metrics: Array<keyof PlayerRanks> = [
    'rankedScoreRank',
    'generalScoreRank',
    'ppScoreRank',
    'wfScoreRank',
    'score12KRank',
  ];
  const fields: Record<keyof PlayerRanks, string> = {
    rankedScoreRank: 'rankedScore',
    generalScoreRank: 'generalScore',
    ppScoreRank: 'ppScore',
    wfScoreRank: 'wfScore',
    score12KRank: 'score12K',
  };

  const counts = await Promise.all(
    metrics.map(async (metric) => {
      const field = fields[metric];
      const mine = Number((doc as any)[field] ?? 0);
      try {
        const response = await client.count({
          index: playerIndexName,
          query: {
            bool: {
              filter: [
                { term: { isBanned: false } },
                { range: { [field]: { gt: mine } } },
              ],
            },
          },
        });
        return response.count;
      } catch (error) {
        logger.error(`Error counting rank for ${field}:`, error);
        return 0;
      }
    }),
  );

  const result: PlayerRanks = {
    rankedScoreRank: counts[0] + 1,
    generalScoreRank: counts[1] + 1,
    ppScoreRank: counts[2] + 1,
    wfScoreRank: counts[3] + 1,
    score12KRank: counts[4] + 1,
  };
  return result;
}

/**
 * Compute the canonical *global* `rankedScoreRank` for a batch of hits. Used by the
 * leaderboard to always expose the rank badge regardless of the active `sortBy` or any
 * filters the caller applied.
 *
 * Important: this rank must be global (count of all non-banned players with strictly
 * greater rankedScore across the entire index, +1). Do NOT substitute the positional
 * index of the hit in the current page — filters and banned-player interleaving make
 * the positional slot diverge from the true leaderboard rank.
 *
 * Runs one `count` query per non-banned hit in parallel. Banned players return -1.
 */
export async function getRankedScoreRanksForHits(
  hits: Array<{ isBanned?: boolean; rankedScore?: number }>,
): Promise<number[]> {
  if (!Array.isArray(hits) || hits.length === 0) return [];

  const results = await Promise.all(
    hits.map(async (doc) => {
      if (doc?.isBanned) return -1;
      const mine = Number(doc?.rankedScore ?? 0);
      try {
        const response = await client.count({
          index: playerIndexName,
          query: {
            bool: {
              filter: [
                { term: { isBanned: false } },
                { range: { rankedScore: { gt: mine } } },
              ],
            },
          },
        });
        return response.count + 1;
      } catch (error) {
        logger.error('Error computing rankedScoreRank for hit:', error);
        return 0;
      }
    }),
  );

  return results;
}

/**
 * Max-value aggregations used as filter ceilings on the leaderboard UI.
 */
export async function getPlayerMaxFields(): Promise<Record<string, number>> {
  try {
    const response = await client.search({
      index: playerIndexName,
      size: 0,
      track_total_hits: false,
      aggs: {
        maxRankedScore: { max: { field: 'rankedScore' } },
        maxGeneralScore: { max: { field: 'generalScore' } },
        maxPpScore: { max: { field: 'ppScore' } },
        maxWfScore: { max: { field: 'wfScore' } },
        maxScore12K: { max: { field: 'score12K' } },
        maxAverageXacc: { max: { field: 'averageXacc' } },
        maxTotalPasses: { max: { field: 'totalPasses' } },
        maxUniversalPassCount: { max: { field: 'universalPassCount' } },
        maxWorldsFirstCount: { max: { field: 'worldsFirstCount' } },
      },
    });
    const aggs = (response as any).aggregations || {};
    const out: Record<string, number> = {};
    for (const key of Object.keys(aggs)) {
      const val = aggs[key]?.value;
      out[key] = typeof val === 'number' && Number.isFinite(val) ? val : 0;
    }
    return out;
  } catch (error) {
    logger.error('Error fetching player max fields:', error);
    return {};
  }
}
