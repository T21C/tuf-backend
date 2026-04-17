import { Router, Request, Response } from 'express';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {
  idParamSpec,
  errorResponseSchema,
  standardErrorResponses404500,
  standardErrorResponses500,
} from '@/server/schemas/common.js';
import { validSortOptions } from '@/config/constants.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {
  getPlayerRanks,
  getPlayerMaxFields,
  getRankedScoreRanksForHits,
  PlayerSearchOptions,
} from '@/server/services/elasticsearch/search/players/playerSearch.js';
import { PlayerStatsService } from '@/server/services/core/PlayerStatsService.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { PaginationQuery } from '@/server/interfaces/models/index.js';

/**
 * v3 players routes — Elasticsearch-backed.
 *
 * Response shapes are flat (no legacy PlayerStats / Player wrapping) and stable.
 * Ranks are computed on-demand per request (5 parallel ES count queries).
 */

const router: Router = Router();
const elasticsearchService = ElasticsearchService.getInstance();
const playerStatsService = PlayerStatsService.getInstance();

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

function parseLimit(raw: unknown, fallback = DEFAULT_LIMIT): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

function parseOffset(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseFilters(raw: unknown): Record<string, any> | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, any>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Search players by text/Discord prefix. Flat shape; no ranks computed for speed.
 *
 * Query params: query, limit (<=100), offset, showBanned (show|hide|only), filters (JSON).
 */
router.get(
  '/search',
  ApiDoc({
    operationId: 'v3GetPlayersSearch',
    summary: 'Search players (v3)',
    description:
      'Elasticsearch-backed player search. Accepts text, `#discordId`, or `@discordUsername` via the `query` param. Returns a flat list sorted by relevance.',
    tags: ['Database', 'Players', 'v3'],
    query: {
      query: { schema: { type: 'string' } },
      limit: { schema: { type: 'string' } },
      offset: { schema: { type: 'string' } },
      showBanned: { schema: { type: 'string' } },
      filters: { schema: { type: 'string' } },
    },
    responses: {
      200: { description: 'Paginated search results' },
      ...standardErrorResponses500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const query = String(req.query.query ?? '').trim();
      const limit = parseLimit(req.query.limit);
      const offset = parseOffset(req.query.offset);
      const showBanned = (req.query.showBanned as 'show' | 'hide' | 'only') || 'hide';
      const filters = parseFilters(req.query.filters);

      const options: PlayerSearchOptions = {
        rawQuery: query || undefined,
        showBanned,
        filters,
        limit,
        offset,
      };

      const { total, hits } = await elasticsearchService.searchPlayers(options);
      return res.json({ total, results: hits, limit, offset });
    } catch (error) {
      logger.error('[v3 /players/search] failure', error);
      return res.status(500).json({
        error: 'Failed to search players',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

/**
 * Paginated leaderboard with sort / filters / text query. ES-backed.
 *
 * Query params: query, sortBy, order, showBanned, limit, offset, filters, page (accepted for compat).
 */
router.get(
  '/leaderboard',
  ApiDoc({
    operationId: 'v3GetLeaderboard',
    summary: 'Player leaderboard (v3)',
    description:
      'Elasticsearch-backed leaderboard. Supports sort, numeric range filters, country filter, showBanned, and text/Discord query (`#id`/`@username`). Returns `maxFields` aggregations for UI filter ceilings.',
    tags: ['Database', 'Leaderboard', 'v3'],
    query: {
      sortBy: { schema: { type: 'string' } },
      order: { schema: { type: 'string' } },
      showBanned: { schema: { type: 'string' } },
      query: { schema: { type: 'string' } },
      offset: { schema: { type: 'string' } },
      limit: { schema: { type: 'string' } },
      filters: { schema: { type: 'string' } },
      page: { schema: { type: 'string' } },
    },
    responses: {
      200: { description: 'Leaderboard results' },
      400: { schema: errorResponseSchema },
      ...standardErrorResponses500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const { page, offset, limit } = req.query as unknown as PaginationQuery;
      const sortBy = (req.query.sortBy as string) || 'rankedScore';
      const order = ((req.query.order as string) || 'desc').toLowerCase();
      const showBanned = ((req.query.showBanned as string) || 'show') as
        | 'show'
        | 'hide'
        | 'only';
      const rawQuery = (req.query.query as string) || undefined;
      const filters = parseFilters(req.query.filters);

      if (!validSortOptions.includes(sortBy)) {
        return res.status(400).json({
          error: `Invalid sortBy option. Valid options are: ${validSortOptions.join(', ')}`,
        });
      }

      const effectiveLimit = parseLimit(limit);
      const effectiveOffset = parseOffset(offset);

      const options: PlayerSearchOptions = {
        rawQuery,
        sortBy,
        order: order === 'asc' ? 'asc' : 'desc',
        showBanned,
        filters,
        limit: effectiveLimit,
        offset: effectiveOffset,
        requireHasPasses: !rawQuery,
      };

      const [{ total, hits }, maxFields] = await Promise.all([
        elasticsearchService.searchPlayers(options),
        getPlayerMaxFields(),
      ]);

      // Always expose `rankedScoreRank` (and `rank`, its canonical alias) on every
      // hit: rankedScore is the defining leaderboard metric, so the UI keeps rendering
      // "#rank" badges even when the user sorts by e.g. generalScore.
      //
      // The rank is ALWAYS global (count of non-banned players with strictly greater
      // rankedScore across the entire index, +1). We must not shortcut to the positional
      // index even when sorting by rankedScore desc, because any active filter (country,
      // numeric range, text query, showBanned) narrows the hit set without narrowing the
      // canonical leaderboard — the positional slot would then point to "#1 within the
      // filter" instead of the global rank. Batched parallel count queries are cheap
      // enough (≤ page size, default 30) that we always use them.
      const rankedScoreRanks = await getRankedScoreRanksForHits(hits);

      const resultsWithRank = hits.map((doc: any, i: number) => ({
        ...doc,
        rankedScoreRank: rankedScoreRanks[i],
        rank: rankedScoreRanks[i],
      }));

      return res.json({
        count: total,
        results: resultsWithRank,
        page,
        offset: effectiveOffset,
        limit: effectiveLimit,
        maxFields,
      });
    } catch (error) {
      logger.error('[v3 /players/leaderboard] failure', error);
      return res.status(500).json({
        error: 'Failed to fetch leaderboard',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

/**
 * Get a single player's ES document + on-demand ranks. Fast profile-card endpoint.
 */
router.get(
  '/:id([0-9]{1,20})',
  ApiDoc({
    operationId: 'v3GetPlayer',
    summary: 'Get player (v3)',
    description:
      'Fetches the player Elasticsearch document by id and attaches freshly-computed ranks (5 parallel ES count queries).',
    tags: ['Database', 'Players', 'v3'],
    params: { id: idParamSpec },
    responses: {
      200: { description: 'Player detail' },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid player id' });
      }

      const doc = await elasticsearchService.getPlayerDocumentById(id);
      if (!doc) return res.status(404).json({ error: 'Player not found' });

      const ranks = await getPlayerRanks(doc);
      return res.json({ ...doc, ...ranks });
    } catch (error) {
      logger.error('[v3 /players/:id] failure', error);
      return res.status(500).json({
        error: 'Failed to fetch player',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

/**
 * Full profile view: ES stats + ranks + DB-enriched passes/topScores/potentialTopScores.
 * Honours "own profile" semantics (shows hidden passes when caller owns the profile).
 */
router.get(
  '/:id([0-9]{1,20})/profile',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'v3GetPlayerProfile',
    summary: 'Get player profile (v3)',
    description:
      'Player profile page payload: ES document + on-demand ranks + DB-sourced passes, topScores, and potentialTopScores. Hidden passes are revealed when the caller owns the profile.',
    tags: ['Database', 'Players', 'v3'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: {
      200: { description: 'Player profile' },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid player id' });
      }

      const user = req.user;
      const isOwnProfile = Boolean(user && user.playerId && user.playerId === id);

      const doc = await elasticsearchService.getPlayerDocumentById(id);
      if (!doc) return res.status(404).json({ error: 'Player not found' });

      const [ranks, enriched] = await Promise.all([
        getPlayerRanks(doc),
        playerStatsService.getEnrichedPlayer(id, isOwnProfile ? user : undefined),
      ]);

      const plainEnriched = enriched
        ? {
            passes: enriched.passes,
            topScores: enriched.topScores?.map((s: any) => (s?.get ? s.get({ plain: true }) : s)),
            potentialTopScores: enriched.potentialTopScores?.map((s: any) =>
              s?.get ? s.get({ plain: true }) : s,
            ),
          }
        : { passes: [], topScores: [], potentialTopScores: [] };

      return res.json({
        ...doc,
        ...ranks,
        ...plainEnriched,
      });
    } catch (error) {
      logger.error('[v3 /players/:id/profile] failure', error);
      return res.status(500).json({
        error: 'Failed to fetch player profile',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

export default router;
