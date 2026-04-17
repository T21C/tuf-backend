import { Request, Response, Router } from 'express';
import { validSortOptions } from '@/config/constants.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { errorResponseSchema, standardErrorResponses500 } from '@/server/schemas/v2/database/index.js';
import { PaginationQuery } from '@/server/interfaces/models/index.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {
  getPlayerMaxFields,
  PlayerSearchOptions,
} from '@/server/services/elasticsearch/search/players/playerSearch.js';
import { esDocToLegacyPlayerStats } from '@/server/services/elasticsearch/adapters/legacyPlayerStatsShape.js';

/**
 * v2 leaderboard — thin backward-compat adapter over the v3 ES search.
 * Preserves the legacy response shape for existing clients while internally
 * querying Elasticsearch (no more player_stats MySQL reads, no 300s HTTP cache).
 */

const router: Router = Router();
const elasticsearchService = ElasticsearchService.getInstance();

router.get(
  '/',
  ApiDoc({
    operationId: 'getLeaderboard',
    summary: 'Leaderboard (v2)',
    description:
      'Paginated player leaderboard backed by Elasticsearch. Legacy response shape preserved for v2 clients; prefer `/v3/players/leaderboard` for new integrations.',
    tags: ['Database', 'Leaderboard'],
    query: {
      page: { schema: { type: 'string' } },
      sortBy: { schema: { type: 'string' } },
      order: { schema: { type: 'string' } },
      showBanned: { schema: { type: 'string' } },
      query: { schema: { type: 'string' } },
      offset: { schema: { type: 'string' } },
      limit: { schema: { type: 'string' } },
      filters: { schema: { type: 'string' } },
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
      const filtersParam = req.query.filters;

      if (!validSortOptions.includes(sortBy)) {
        return res.status(400).json({
          error: `Invalid sortBy option. Valid options are: ${validSortOptions.join(', ')}`,
        });
      }

      let filters: Record<string, any> | undefined;
      if (filtersParam && typeof filtersParam === 'string' && filtersParam.trim().length > 0) {
        try {
          const parsed = JSON.parse(filtersParam.trim());
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            filters = parsed as Record<string, any>;
          }
        } catch {
          filters = undefined;
        }
      }

      const effectiveOffset = Number.isFinite(Number(offset)) && Number(offset) >= 0 ? Number(offset) : 0;
      const effectiveLimit = (() => {
        const n = Number(limit);
        if (!Number.isFinite(n)) return 30;
        return Math.min(100, Math.max(1, n));
      })();

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

      // Legacy shape expected: results[].player.{...}, results[].rankedScore, etc.
      const results = hits.map((doc) => esDocToLegacyPlayerStats(doc));

      return res.json({
        count: total,
        results,
        page,
        offset: effectiveOffset,
        limit: effectiveLimit,
        maxFields,
      });
    } catch (error) {
      logger.error('Error fetching leaderboard:', error);
      return res.status(500).json({
        error: 'Failed to fetch leaderboard',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

export default router;
