import {Request, Response, Router} from 'express';
import {validSortOptions} from '@/config/constants.js';
import {PlayerStatsService} from '@/server/services/core/PlayerStatsService.js';
import User from '@/models/auth/User.js';
import OAuthProvider from '@/models/auth/OAuthProvider.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { Cache, CacheInvalidation } from '@/server/middleware/cache.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { errorResponseSchema, standardErrorResponses500 } from '@/server/schemas/v2/database/index.js';
import PlayerStats from '@/models/players/PlayerStats.js';
import { PaginationQuery } from '@/server/interfaces/models/index.js';

const router: Router = Router();
const playerStatsService = PlayerStatsService.getInstance();

router.get(
  '/',
  ApiDoc({
    operationId: 'getLeaderboard',
    summary: 'Leaderboard',
    description: 'Paginated player leaderboard with sort, filters, and optional query (#discordId or @username). Query: page, offset, limit, sortBy, order, showBanned, query, filters. Cached.',
    tags: ['Database', 'Leaderboard'],
    query: { page: { schema: { type: 'string' } }, sortBy: { schema: { type: 'string' } }, order: { schema: { type: 'string' } }, showBanned: { schema: { type: 'string' } }, query: { schema: { type: 'string' } }, offset: { schema: { type: 'string' } }, limit: { schema: { type: 'string' } }, filters: { schema: { type: 'string' } } },
    responses: { 200: { description: 'Leaderboard results' }, 400: { schema: errorResponseSchema }, ...standardErrorResponses500 },
  }),
  Cache({
  ttl: 300,
  varyByQuery: ['sortBy', 'order', 'showBanned', 'query', 'offset', 'limit', 'filters'],
  tags: ['leaderboard:all']
}),
  async (req: Request, res: Response) => {
  try {
    const { page, offset, limit } = req.query as unknown as PaginationQuery;
    const {
      sortBy = 'rankedScore',
      order = 'desc',
      showBanned = 'show',
      query,
      filters: filtersParam
    } = req.query;

    if (!validSortOptions.includes(sortBy as string)) {
      return res.status(400).json({
        error: `Invalid sortBy option. Valid options are: ${validSortOptions.join(', ')}`,
      });
    }

    // Parse filters from query params: try JSON.parse once, use only if it yields a plain object
    let filters: Record<string, [number, number]> | undefined;
    if (filtersParam && typeof filtersParam === 'string' && filtersParam.trim().length > 0) {
      try {
        const parsed = JSON.parse(filtersParam.trim());
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          filters = parsed as Record<string, [number, number]>;
        } else {
          filters = undefined;
        }
      } catch {
        filters = undefined;
      }
    }

    // Get max fields for filter limits (cached or fresh)
    const maxFields = await playerStatsService.getMaxFields();

    // If there's a query and it starts with #, treat it as a Discord ID search
    if (query && typeof query === 'string' && query.startsWith('#')) {
      const idQuery = parseInt(query.slice(1)); // Remove the # prefix
      if (isNaN(idQuery) || idQuery < 1) {
        return res.json({ count: 0, results: [], page, offset, limit, maxFields });
      }
      // Find the user with this Discord OAuth provider
      const userWithDiscord = await User.findOne({
        include: [
          {
            model: OAuthProvider,
            as: 'providers',
            where: {
              provider: 'discord',
              providerId: idQuery,
            },
          },
        ],
      });
      const lookupId = userWithDiscord?.playerId || idQuery;
      const { total, players } = await playerStatsService.getLeaderboard(
        sortBy as string,
        order as 'asc' | 'desc',
        showBanned as 'show' | 'hide' | 'only',
        lookupId,
        offset,
        limit,
        undefined,
        filters
      );
      return res.json({ count: total, results: players, page, offset, limit, maxFields });
    }


    if (query && typeof query === 'string' && query.startsWith('@')) {
      const idQuery = query.slice(1); // Remove the @ prefix

      // Find the user with this Discord OAuth provider
      const userWithDiscord = await User.findOne({
        include: [
          {
            model: OAuthProvider,
            as: 'providers',
            where: {
              provider: 'discord',
              profile: {
                username: idQuery,
              },
            },
          },
        ],
      });
      const { total, players } = await playerStatsService.getLeaderboard(
        sortBy as string,
        order as 'asc' | 'desc',
        showBanned as 'show' | 'hide' | 'only',
        userWithDiscord?.playerId || 0,
        offset,
        limit,
        undefined,
        filters
      );
      return res.json({ count: total, results: players, page, offset, limit, maxFields });
    }

    // Regular leaderboard fetch without Discord ID filter
    const { total, players } = await playerStatsService.getLeaderboard(
      sortBy as string,
      order as 'asc' | 'desc',
      showBanned as 'show' | 'hide' | 'only',
      undefined,
      offset,
      limit,
      query as string, // Pass the query string for name search
      filters
    );

    return res.json({ count: total, results: players, page, offset, limit, maxFields });
  } catch (error) {
    logger.error('Error fetching leaderboard:', error);
    return res.status(500).json({
      error: 'Failed to fetch leaderboard',
      details: error instanceof Error ? error.message : String(error),
    });
  }
  }
);

// =============== CACHE CONTROL =================

const invalidatePlayerStatsCache = async () => {
  await CacheInvalidation.invalidateTags(['leaderboard:all']);
};


PlayerStats.afterBulkCreate('cacheInvalidationPlayerStatsBulkCreate', async (instances: any, options: any) => {
  if (options.transaction) {
    await options.transaction.afterCommit(async () => {
      await invalidatePlayerStatsCache();
    });
  }
});

export default router;
