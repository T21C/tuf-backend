import client, { playerIndexName } from '@/config/elasticsearch.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { applyIdsFilter, rangeOnField, termField } from '@/server/services/elasticsearch/search/tools/esQueryBuilder/esQueryPrimitives.js';
import {
  clampRankRange,
  intersectRankedScoreFilters,
  parseNumericRange,
  parseRankedScoreRankRange,
  rankedScoreWindowForClampedRange,
  type RankedScoreWindow,
  type ScoreRangeBounds,
} from '@/server/services/elasticsearch/search/players/rankedScoreRankWindow.js';

export type PlayerFlagField = 'isBanned' | 'isSubmissionsPaused' | 'isRatingBanned';
export type PlayerFlagMode = 'show' | 'hide' | 'only';

export interface PlayerSearchOptions {
  /** Plain text search — matches player name, user.username, user.nickname. */
  text?: string;
  /** Raw query string; `#` = Discord provider id, `@` = Discord username, `pid:` = player id. */
  rawQuery?: string;
  /** When true, only players with an indexed auth user (`user.id`). */
  requireLinkedUser?: boolean;
  /** When true, exclude players whose linked user is already tied to a creator. */
  excludeCreatorLinked?: boolean;
  /** Player moderation flag field to filter on. */
  flagField?: PlayerFlagField;
  /** How to filter the selected moderation flag. */
  flagMode?: PlayerFlagMode;
  /** @deprecated Use `flagField` + `flagMode`. Kept for backward compatibility. */
  showBanned?: PlayerFlagMode;
  /** Range filters (numeric metrics, `country` exact match, optional `rankedScoreRank` `[min, max]`). */
  filters?: Record<string, [number, number] | string>;
  /** Sort key (see mapping below). */
  sortBy?: string;
  order?: 'asc' | 'desc';
  offset?: number;
  limit?: number;
  /** Requires `totalPasses > 0` (default leaderboard behavior when no query). */
  requireHasPasses?: boolean;
  /** Restrict to these player ids (following `only`). Empty matches nothing. */
  ids?: number[];
  /** When `exclude`, omit these ids (following `hide`). */
  idsMode?: 'include' | 'exclude';
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
  totalScoreV2: 'totalScoreV2',
  ppScore: 'ppScore',
  wfScore: 'wfScore',
  wfPPScore: 'wfPPScore',
  score12K: 'score12K',
  averageXacc: 'averageXacc',
  totalPasses: 'totalPasses',
  universalPassCount: 'universalPassCount',
  worldsFirstCount: 'worldsFirstCount',
  worldsFirstPPCount: 'worldsFirstPPCount',
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
  'totalScoreV2',
  'ppScore',
  'wfScore',
  'wfPPScore',
  'score12K',
  'averageXacc',
  'totalPasses',
  'universalPassCount',
  'worldsFirstCount',
  'worldsFirstPPCount',
]);

const ALLOWED_FLAG_FIELDS = new Set<PlayerFlagField>([
  'isBanned',
  'isSubmissionsPaused',
  'isRatingBanned',
]);

const ALLOWED_FLAG_MODES = new Set<PlayerFlagMode>(['show', 'hide', 'only']);

export function parsePlayerFlagFilter(input: {
  flagField?: unknown;
  flagMode?: unknown;
  showBanned?: unknown;
  defaultMode?: PlayerFlagMode;
}): { field: PlayerFlagField; mode: PlayerFlagMode } {
  const defaultMode = input.defaultMode ?? 'show';
  const rawField = typeof input.flagField === 'string' ? input.flagField : undefined;
  const rawMode = typeof input.flagMode === 'string' ? input.flagMode : undefined;
  const legacyMode = typeof input.showBanned === 'string' ? input.showBanned : undefined;

  const field: PlayerFlagField =
    rawField && ALLOWED_FLAG_FIELDS.has(rawField as PlayerFlagField)
      ? (rawField as PlayerFlagField)
      : 'isBanned';

  const modeCandidate = rawMode ?? legacyMode ?? defaultMode;
  const mode: PlayerFlagMode = ALLOWED_FLAG_MODES.has(modeCandidate as PlayerFlagMode)
    ? (modeCandidate as PlayerFlagMode)
    : defaultMode;

  return { field, mode };
}

function applyPlayerFlagFilter(
  filter: any[],
  options: Pick<PlayerSearchOptions, 'flagField' | 'flagMode' | 'showBanned'>,
  defaultMode: PlayerFlagMode = 'show',
): void {
  const { field, mode } = parsePlayerFlagFilter({
    flagField: options.flagField,
    flagMode: options.flagMode,
    showBanned: options.showBanned,
    defaultMode,
  });

  if (mode === 'hide') {
    filter.push(termField(field, false));
  } else if (mode === 'only') {
    filter.push(termField(field, true));
  }
}

function parseSpecialPrefix(raw?: string): {
  cleaned?: string;
  discordProviderId?: string;
  discordUsername?: string;
  playerId?: number;
} {
  if (!raw) return {};
  const q = raw.trim();
  if (q.toLowerCase().startsWith('pid:')) {
    const idStr = q.slice(4);
    if (/^[0-9]+$/.test(idStr)) {
      return { playerId: parseInt(idStr, 10) };
    }
    return {};
  }
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
    {
      nested: {
        path: 'aliases',
        query: {
          wildcard: {
            'aliases.name.lower': { value: wildcardValue, boost: 3, case_insensitive: true },
          },
        },
        score_mode: 'max',
      },
    },
    // Fuzzy/text fields fall back via match
    { match: { name: { query: text, boost: 1 } } },
    { match: { 'user.username': { query: text, boost: 1 } } },
  ];
}

const ES_MAX_RESULT_WINDOW = 10000;
const RANK_WINDOW_CACHE_TTL_MS = 15_000;

type RankWindowCacheEntry = {expiresAt: number; value: RankedScoreWindow};
const rankWindowCache = new Map<string, RankWindowCacheEntry>();

function getCachedRankWindow(key: string): RankedScoreWindow | undefined {
  const hit = rankWindowCache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    rankWindowCache.delete(key);
    return undefined;
  }
  return hit.value;
}

function setCachedRankWindow(key: string, value: RankedScoreWindow): void {
  rankWindowCache.set(key, {expiresAt: Date.now() + RANK_WINDOW_CACHE_TTL_MS, value});
  if (rankWindowCache.size <= 64) return;
  const oldest = rankWindowCache.keys().next().value;
  if (oldest != null) rankWindowCache.delete(oldest);
}

/** Same eligibility as the live leaderboard list: not banned and at least one clear. */
function leaderboardRankBaseFilter(): Record<string, unknown>[] {
  return [
    {term: {isBanned: false}},
    {range: {totalPasses: {gt: 0}}},
  ];
}

function leaderboardRankQuery(extraFilter: Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    bool: {
      filter: [...leaderboardRankBaseFilter(), ...extraFilter],
    },
  };
}

async function countLeaderboardRankPopulation(): Promise<number> {
  const response = await client.count({
    index: playerIndexName,
    query: leaderboardRankQuery(),
  });
  return response.count ?? 0;
}

async function rankedScoreAtPosition(position: number, population: number): Promise<number | null> {
  if (position < 1 || position > population) return null;

  if (position <= ES_MAX_RESULT_WINDOW) {
    const response = await client.search({
      index: playerIndexName,
      query: leaderboardRankQuery(),
      sort: [{rankedScore: 'desc'}, {id: 'desc'}],
      from: position - 1,
      size: 1,
      _source: ['rankedScore'],
      track_total_hits: false,
    });
    const src = response.hits.hits[0]?._source as {rankedScore?: number} | undefined;
    const score = Number(src?.rankedScore);
    return Number.isFinite(score) ? score : null;
  }

  return rankedScoreAtPositionByBinarySearch(position);
}

async function rankedScoreAtPositionByBinarySearch(position: number): Promise<number | null> {
  const extents = await client.search({
    index: playerIndexName,
    size: 0,
    track_total_hits: false,
    query: leaderboardRankQuery(),
    aggs: {
      minScore: {min: {field: 'rankedScore'}},
      maxScore: {max: {field: 'rankedScore'}},
    },
  });
  const aggs = (extents as any).aggregations || {};
  const minScore = Number(aggs.minScore?.value);
  const maxScore = Number(aggs.maxScore?.value);
  if (!Number.isFinite(minScore) || !Number.isFinite(maxScore)) return null;
  if (minScore === maxScore) return minScore;

  let lo = minScore;
  let hi = maxScore;
  for (let i = 0; i < 64; i++) {
    const mid = lo + (hi - lo) / 2;
    const greater = await client.count({
      index: playerIndexName,
      query: leaderboardRankQuery([{range: {rankedScore: {gt: mid}}}]),
    });
    if ((greater.count ?? 0) >= position) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const snap = await client.search({
    index: playerIndexName,
    query: leaderboardRankQuery([{range: {rankedScore: {lte: hi}}}]),
    sort: [{rankedScore: 'desc'}, {id: 'desc'}],
    size: 1,
    _source: ['rankedScore'],
    track_total_hits: false,
  });
  const src = snap.hits.hits[0]?._source as {rankedScore?: number} | undefined;
  const score = Number(src?.rankedScore);
  return Number.isFinite(score) ? score : null;
}

async function computeRankedScoreWindow(minRank: number, maxRank: number): Promise<RankedScoreWindow> {
  const population = await countLeaderboardRankPopulation();
  const clamped = clampRankRange(minRank, maxRank, population);
  if (clamped.kind === 'empty') return {type: 'empty'};
  if (clamped.kind === 'all') return {type: 'all'};

  const [atMax, atMinMinusOne] = await Promise.all([
    rankedScoreAtPosition(clamped.max, population),
    clamped.min > 1 ? rankedScoreAtPosition(clamped.min - 1, population) : Promise.resolve(null),
  ]);
  return rankedScoreWindowForClampedRange(clamped, {atMax, atMinMinusOne});
}

type RankedScoreFilterResolution =
  | {kind: 'pass-through'}
  | {kind: 'empty'}
  | {kind: 'override'; bounds: ScoreRangeBounds};

async function resolveRankedScoreRankFilter(
  filters: PlayerSearchOptions['filters'],
): Promise<RankedScoreFilterResolution> {
  const parsed = parseRankedScoreRankRange(filters?.rankedScoreRank);
  if (!parsed) return {kind: 'pass-through'};

  const cacheKey = `passes:${parsed.min}:${parsed.max}`;
  let rankWindow = getCachedRankWindow(cacheKey);
  if (!rankWindow) {
    rankWindow = await computeRankedScoreWindow(parsed.min, parsed.max);
    setCachedRankWindow(cacheKey, rankWindow);
  }

  const statRange = parseNumericRange(filters?.rankedScore);
  const merged = intersectRankedScoreFilters(rankWindow, statRange);
  if (merged.empty) return {kind: 'empty'};
  if (rankWindow.type === 'all') return {kind: 'pass-through'};
  if (!merged.bounds) return {kind: 'pass-through'};
  return {kind: 'override', bounds: merged.bounds};
}

function buildPlayerQuery(
  options: PlayerSearchOptions,
  rankOverride?: ScoreRangeBounds | null,
): any {
  const must: any[] = [];
  const should: any[] = [];
  const filter: any[] = [];
  const mustNot: any[] = [];

  const {
    cleaned,
    discordProviderId,
    discordUsername,
    playerId,
  } = parseSpecialPrefix(options.rawQuery ?? options.text);

  if (playerId != null) {
    must.push(termField('id', playerId));
  } else if (discordProviderId) {
    must.push(termField('discord.providerId', discordProviderId));
  } else if (discordUsername) {
    must.push(termField('discord.username.lower', discordUsername.toLowerCase(), true));
  } else {
    const text = cleaned ?? options.text;
    if (text && text.trim().length > 0) {
      should.push(...buildTextShould(text.trim()));
    }
  }

  applyPlayerFlagFilter(filter, options);
  applyIdsFilter(filter, options.ids, options.idsMode === 'exclude' ? 'exclude' : 'include');

  if (options.requireHasPasses && (options.ids == null || options.idsMode === 'exclude')) {
    filter.push({ range: { totalPasses: { gt: 0 } } });
  }

  if (options.requireLinkedUser) {
    filter.push({ exists: { field: 'user.id' } });
  }

  if (options.excludeCreatorLinked) {
    mustNot.push({ exists: { field: 'user.creator.id' } });
  }

  if (options.filters) {
    for (const [key, value] of Object.entries(options.filters)) {
      if (key === 'rankedScoreRank') continue;
      if (key === 'country' && typeof value === 'string' && value.length > 0) {
        filter.push(termField('country', value));
        continue;
      }
      if (key === 'rankedScore' && rankOverride) continue;
      if (NUMERIC_FILTER_FIELDS.has(key) && Array.isArray(value) && value.length === 2) {
        const [min, max] = value;
        if (Number.isFinite(min) && Number.isFinite(max)) {
          filter.push(rangeOnField(key, { gte: Number(min), lte: Number(max) }));
        }
      }
    }
  }

  if (rankOverride) {
    filter.push(termField('isBanned', false));
    filter.push(rangeOnField('rankedScore', rankOverride));
  }

  const query: any = { bool: {} };
  if (must.length > 0) query.bool.must = must;
  if (filter.length > 0) query.bool.filter = filter;
  if (mustNot.length > 0) query.bool.must_not = mustNot;
  if (should.length > 0) {
    query.bool.should = should;
    query.bool.minimum_should_match = 1;
  }
  if (!query.bool.must && !query.bool.should && !query.bool.filter && !query.bool.must_not) {
    query.bool.must = [{ match_all: {} }];
  }
  return query;
}

/**
 * Sort keys that produce large ties (same top-difficulty tier, or many players capped at
 * 100% average xacc). Tiebreak with `rankedScore desc` so ordering inside a tier reflects
 * leaderboard strength instead of insertion order / document id.
 */
const TIEBREAK_ON_RANKED_SCORE = new Set([
  'topDiffSortOrder',
  'top12kDiffSortOrder',
  'averageXacc',
]);

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

    const rankResolution = await resolveRankedScoreRankFilter(options.filters);
    if (rankResolution.kind === 'empty') {
      return {hits: [], total: 0, offset, limit};
    }
    if (rankResolution.kind === 'override') {
      const {field, mode} = parsePlayerFlagFilter(options);
      if (field === 'isBanned' && mode === 'only') {
        return {hits: [], total: 0, offset, limit};
      }
    }

    const query = buildPlayerQuery(
      options,
      rankResolution.kind === 'override' ? rankResolution.bounds : null,
    );
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
  wfPPScoreRank: number;
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
  wfPPScore?: number;
  score12K?: number;
}): Promise<PlayerRanks> {
  if (doc?.isBanned) {
    return {
      rankedScoreRank: -1,
      generalScoreRank: -1,
      ppScoreRank: -1,
      wfScoreRank: -1,
      wfPPScoreRank: -1,
      score12KRank: -1,
    };
  }

  const metrics: Array<keyof PlayerRanks> = [
    'rankedScoreRank',
    'generalScoreRank',
    'ppScoreRank',
    'wfScoreRank',
    'wfPPScoreRank',
    'score12KRank',
  ];
  const fields: Record<keyof PlayerRanks, string> = {
    rankedScoreRank: 'rankedScore',
    generalScoreRank: 'generalScore',
    ppScoreRank: 'ppScore',
    wfScoreRank: 'wfScore',
    wfPPScoreRank: 'wfPPScore',
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
    wfPPScoreRank: counts[4] + 1,
    score12KRank: counts[5] + 1,
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
 * `rankedPopulation` is the number of non-banned players with at least one clear
 * (the same set the live leaderboard lists when there is no search query).
 */
export async function getPlayerMaxFields(): Promise<Record<string, number>> {
  try {
    const [response, rankedPopulation] = await Promise.all([
      client.search({
        index: playerIndexName,
        size: 0,
        track_total_hits: false,
        aggs: {
          maxRankedScore: { max: { field: 'rankedScore' } },
          maxTotalScoreV2: { max: { field: 'totalScoreV2' } },
          maxGeneralScore: { max: { field: 'generalScore' } },
          maxPpScore: { max: { field: 'ppScore' } },
          maxWfScore: { max: { field: 'wfScore' } },
          maxWfPPScore: { max: { field: 'wfPPScore' } },
          maxScore12K: { max: { field: 'score12K' } },
          maxAverageXacc: { max: { field: 'averageXacc' } },
          maxTotalPasses: { max: { field: 'totalPasses' } },
          maxUniversalPassCount: { max: { field: 'universalPassCount' } },
          maxWorldsFirstCount: { max: { field: 'worldsFirstCount' } },
          maxWorldsFirstPPCount: { max: { field: 'worldsFirstPPCount' } },
        },
      }),
      countLeaderboardRankPopulation().catch((error) => {
        logger.error('Error counting ranked population:', error);
        return 0;
      }),
    ]);
    const aggs = (response as any).aggregations || {};
    const out: Record<string, number> = {};
    for (const key of Object.keys(aggs)) {
      const val = aggs[key]?.value;
      out[key] = typeof val === 'number' && Number.isFinite(val) ? val : 0;
    }
    out.rankedPopulation = rankedPopulation;
    return out;
  } catch (error) {
    logger.error('Error fetching player max fields:', error);
    return {};
  }
}

const PLAYER_ID_FILTER_CAP = 10_000;

/**
 * Resolve player IDs matching text search within a known id set (pending submission queue).
 * Returns an empty list when the query has no player text clauses, so a constrained id set
 * is never treated as match-all.
 */
export async function searchPlayerIdsInSet(
  query: string,
  playerIds: number[],
): Promise<number[]> {
  const unique = [...new Set(playerIds)].filter((id) => Number.isFinite(id) && id > 0);
  const trimmed = String(query ?? '').trim();
  if (unique.length === 0 || !trimmed) {
    return [];
  }

  const esQuery = buildPlayerQuery(
    {
      rawQuery: trimmed.length > 255 ? trimmed.slice(0, 255) : trimmed,
      ids: unique,
      requireHasPasses: false,
      flagMode: 'show',
    },
    null,
  );
  if (!esQuery?.bool?.should?.length && !esQuery?.bool?.must?.length) {
    return [];
  }

  const size = Math.min(unique.length, PLAYER_ID_FILTER_CAP);
  try {
    const response = await client.search({
      index: playerIndexName,
      query: esQuery,
      from: 0,
      size,
      _source: false,
      track_total_hits: false,
    });
    return response.hits.hits
      .map((hit) => parseInt(String(hit._id), 10))
      .filter((id) => Number.isFinite(id) && id > 0);
  } catch (error) {
    logger.error('Error in searchPlayerIdsInSet:', error);
    throw error;
  }
}
