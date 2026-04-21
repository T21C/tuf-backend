import { Op } from 'sequelize';
import client, { creatorIndexName } from '@/config/elasticsearch.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { rangeOnField, termField } from '@/server/services/elasticsearch/search/tools/esQueryBuilder/esQueryPrimitives.js';
import { validCreatorVerificationStatuses } from '@/config/constants.js';
import User from '@/models/auth/User.js';
import { estypes } from '@elastic/elasticsearch';

export interface CreatorSearchOptions {
  /** Plain text search — matches creator name, aliases, user.username. */
  text?: string;
  /** Raw query string; reserved for future special-prefix handling (e.g. `@username`). */
  rawQuery?: string;
  /**
   * Range filters (numeric metrics) plus `verificationStatus` exact-match filter.
   * `verificationStatus` accepts a single string or an array of strings (terms query).
   */
  filters?: Record<string, [number, number] | string | string[] | boolean>;
  /** Sort key (see CREATOR_SORT_FIELD_MAP below). */
  sortBy?: string;
  order?: 'asc' | 'desc';
  offset?: number;
  limit?: number;
  /** Requires `chartsTotal > 0` (default leaderboard behavior when no query). */
  requireHasCharts?: boolean;
}

export interface CreatorSearchResult {
  total: number;
  hits: any[];
  offset: number;
  limit: number;
}

const CREATOR_SORT_FIELD_MAP: Record<string, string> = {
  chartsTotal: 'chartsTotal',
  chartsCreated: 'chartsCreated',
  chartsCharted: 'chartsCharted',
  chartsVfxed: 'chartsVfxed',
  chartsTeamed: 'chartsTeamed',
  totalChartClears: 'totalChartClears',
  totalChartLikes: 'totalChartLikes',
  name: 'name.lower',
  id: 'id',
};

const NUMERIC_FILTER_FIELDS = new Set([
  'chartsTotal',
  'chartsCreated',
  'chartsCharted',
  'chartsVfxed',
  'chartsTeamed',
  'totalChartClears',
  'totalChartLikes',
]);

function parseSpecialPrefix(raw?: string): {
  cleaned?: string;
  username?: string;
} {
  if (!raw) return {};
  const q = raw.trim();
  if (q.startsWith('@')) {
    const uname = q.slice(1);
    if (uname.length > 0) return { username: uname };
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
    { term: { 'name.lower': { value: lc, boost: 10, case_insensitive: true } } },
    { term: { 'user.username.lower': { value: lc, boost: 9, case_insensitive: true } } },
    { wildcard: { 'name.lower': { value: prefixValue, boost: 5, case_insensitive: true } } },
    { wildcard: { 'user.username.lower': { value: prefixValue, boost: 5, case_insensitive: true } } },
    { wildcard: { 'name.lower': { value: wildcardValue, boost: 2, case_insensitive: true } } },
    { wildcard: { 'user.username.lower': { value: wildcardValue, boost: 2, case_insensitive: true } } },
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
    { match: { name: { query: text, boost: 1 } } },
    { match: { 'user.username': { query: text, boost: 1 } } },
  ];
}

function buildCreatorQuery(options: CreatorSearchOptions): any {
  const must: any[] = [];
  const should: any[] = [];
  const filter: any[] = [];

  const { cleaned, username } = parseSpecialPrefix(options.rawQuery ?? options.text);

  if (username) {
    must.push(termField('user.username.lower', username.toLowerCase(), true));
  } else {
    const text = cleaned ?? options.text;
    if (text && text.trim().length > 0) {
      should.push(...buildTextShould(text.trim()));
    }
  }

  if (options.requireHasCharts) {
    filter.push({ range: { chartsTotal: { gt: 0 } } });
  }

  if (options.filters) {
    for (const [key, value] of Object.entries(options.filters)) {
      if (key === 'verificationStatus') {
        const allowed = validCreatorVerificationStatuses as readonly string[];
        const raw: unknown[] = Array.isArray(value) ? (value as unknown[]) : [value];
        const values = raw.filter((v): v is string => typeof v === 'string' && allowed.includes(v));
        if (values.length === 1) {
          filter.push(termField('verificationStatus', values[0]));
        } else if (values.length > 1) {
          filter.push({ terms: { verificationStatus: values } });
        }
        continue;
      }
      if (NUMERIC_FILTER_FIELDS.has(key) && Array.isArray(value) && value.length === 2) {
        const [min, max] = value as [number, number];
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

function buildCreatorSort(options: CreatorSearchOptions): any[] {
  const order = options.order === 'asc' ? 'asc' : 'desc';
  const mapped = options.sortBy ? CREATOR_SORT_FIELD_MAP[options.sortBy] : undefined;

  if (!mapped) {
    return [{ _score: 'desc' }, { id: 'desc' }];
  }

  const sort: any[] = [{ [mapped]: order }];
  // Tiebreak by chartsTotal so chunky enums (e.g. low chart counts) don't all collapse on id alone.
  if (mapped !== 'chartsTotal' && mapped !== 'id' && mapped !== 'name.lower') {
    sort.push({ chartsTotal: 'desc' });
  }
  sort.push({ id: 'desc' });
  return sort;
}

/**
 * Hydrate creator hits with up-to-date user data (notably `avatarUrl` and
 * `username`/`nickname`) from the User table. The ES index is refreshed on
 * profile-change events but can lag behind avatar changes — this guarantees
 * search results never display stale avatars without paying for a full
 * reindex on every user-profile edit.
 *
 * Mirrors the difficulty hydration done by the level search.
 */
export async function hydrateCreatorUsers(sources: any[]): Promise<any[]> {
  if (sources.length === 0) return sources;

  const userIds = Array.from(
    new Set(
      sources
        .map((s) => s?.user?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  );

  if (userIds.length === 0) return sources;

  const users = await User.findAll({
    where: { id: { [Op.in]: userIds } },
    attributes: ['id', 'username', 'nickname', 'avatarUrl', 'playerId'],
  });
  const userById = new Map(users.map((u) => [u.id, u]));

  return sources.map((source) => {
    if (!source?.user?.id) return source;
    const fresh = userById.get(source.user.id);
    if (!fresh) return source;
    return {
      ...source,
      user: {
        ...source.user,
        username: fresh.username,
        nickname: fresh.nickname ?? null,
        avatarUrl: fresh.avatarUrl ?? null,
        playerId: fresh.playerId ?? source.user.playerId ?? null,
      },
    };
  });
}

export async function searchCreators(options: CreatorSearchOptions): Promise<CreatorSearchResult> {
  try {
    const offset = Math.max(0, Number(options.offset) || 0);
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 30));

    const query = buildCreatorQuery(options);
    const sort = buildCreatorSort(options);

    const response = await client.search({
      index: creatorIndexName,
      query,
      sort,
      from: offset,
      size: limit,
      track_total_hits: true,
    }) as estypes.SearchResponse;

    const sources = response.hits.hits.map((h) => h._source);
    const hits = await hydrateCreatorUsers(sources);
    const total = response.hits.total
      ? typeof response.hits.total === 'number'
        ? response.hits.total
        : response.hits.total.value
      : 0;

    return { hits, total, offset, limit };
  } catch (error) {
    logger.error('Error searching creators:', error);
    throw error;
  }
}

/**
 * Max-value aggregations used as filter ceilings on the creator listing UI.
 */
export async function getCreatorMaxFields(): Promise<Record<string, number>> {
  try {
    const response = await client.search({
      index: creatorIndexName,
      size: 0,
      track_total_hits: false,
      aggs: {
        maxChartsTotal: { max: { field: 'chartsTotal' } },
        maxChartsCreated: { max: { field: 'chartsCreated' } },
        maxChartsCharted: { max: { field: 'chartsCharted' } },
        maxChartsVfxed: { max: { field: 'chartsVfxed' } },
        maxChartsTeamed: { max: { field: 'chartsTeamed' } },
        maxTotalChartClears: { max: { field: 'totalChartClears' } },
        maxTotalChartLikes: { max: { field: 'totalChartLikes' } },
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
    logger.error('Error fetching creator max fields:', error);
    return {};
  }
}
