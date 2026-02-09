import {Request, Response, Router} from 'express';
import {validSortOptions} from '../../../config/constants.js';
import {PlayerStatsService} from '../../services/PlayerStatsService.js';
import User from '../../../models/auth/User.js';
import OAuthProvider from '../../../models/auth/OAuthProvider.js';
import { logger } from '../../services/LoggerService.js';
import { Cache, CacheInvalidation } from '../../middleware/cache.js';
import PlayerStats from '../../../models/players/PlayerStats.js';

const router: Router = Router();
const playerStatsService = PlayerStatsService.getInstance();

router.get('/', Cache({
  ttl: 300,
  varyByQuery: ['sortBy', 'order', 'showBanned', 'query', 'offset', 'limit', 'filters'],
  tags: ['leaderboard:all'] // Tag all list queries
}), async (req: Request, res: Response) => {
  try {
    const {
      sortBy = 'rankedScore',
      order = 'desc',
      showBanned = 'show',
      query,
      offset = '0',
      limit = '30',
      filters: filtersParam
    } = req.query;

    if (!validSortOptions.includes(sortBy as string)) {
      return res.status(400).json({
        error: `Invalid sortBy option. Valid options are: ${validSortOptions.join(', ')}`,
      });
    }

    // Parse offset and limit to numbers
    const offsetNum = Math.max(0, parseInt(offset as string) || 0);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit as string) || 30));

    // Parse filters from query params with validation
    let filters: Record<string, [number, number]> | undefined;
    if (filtersParam && typeof filtersParam === 'string' && filtersParam.trim().length > 0) {
      try {
        const trimmedFilters = filtersParam.trim();
        
        // Check if JSON string appears incomplete (basic validation)
        const openBraces = (trimmedFilters.match(/{/g) || []).length;
        const closeBraces = (trimmedFilters.match(/}/g) || []).length;
        const openBrackets = (trimmedFilters.match(/\[/g) || []).length;
        const closeBrackets = (trimmedFilters.match(/\]/g) || []).length;
        
        // If braces/brackets are unbalanced, the JSON is incomplete
        if (openBraces !== closeBraces || openBrackets !== closeBrackets) {
          logger.debug('Incomplete filters JSON detected, ignoring filters:', {filters: trimmedFilters});
          // Don't return error, just ignore the filters and continue without them
          filters = undefined;
        } else {
          // Replace invalid JSON values before parsing
          let sanitizedFilters = trimmedFilters
            .replace(/"Infinity"/g, '"2147483647"')
            .replace(/"-Infinity"/g, '"-2147483647"')
            .replace(/"NaN"/g, '"0"');

          const parsed = JSON.parse(sanitizedFilters, (key, value) => {
            if (typeof value === 'number') {
              return Number.parseFloat(value.toString());
            }
            return value;
          });
          
          // Validate that parsed filters have the correct structure
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            // Check if all values are arrays of 2 numbers
            const isValid = Object.values(parsed).every(value => 
              Array.isArray(value) && 
              value.length === 2 && 
              typeof value[0] === 'number' && 
              typeof value[1] === 'number'
            );
            
            if (isValid) {
              filters = parsed as Record<string, [number, number]>;
            } else {
              logger.debug('Invalid filter structure, ignoring filters:', {filters: trimmedFilters});
              filters = undefined;
            }
          } else {
            logger.debug('Filters must be an object, ignoring:', {filters: trimmedFilters});
            filters = undefined;
          }
        }
      } catch (error) {
        logger.error('Error parsing filters:', {
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack,
            name: error.name
          } : error,
          filters: filtersParam
        });
        // Don't return error, just ignore the filters and continue without them
        filters = undefined;
      }
    }

    // Get max fields for filter limits (cached or fresh)
    const maxFields = await playerStatsService.getMaxFields();

    // If there's a query and it starts with #, treat it as a Discord ID search
    if (query && typeof query === 'string' && query.startsWith('#')) {
      const idQuery = parseInt(query.slice(1)); // Remove the # prefix
      if (isNaN(idQuery) || idQuery < 1) {
        return res.json({ count: 0, results: [] });
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
        offsetNum,
        limitNum,
        undefined,
        filters
      );
      return res.json({ count: total, results: players, maxFields });
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
        offsetNum,
        limitNum,
        undefined,
        filters
      );
      return res.json({ count: total, results: players, maxFields });
    }

    // Regular leaderboard fetch without Discord ID filter
    const { total, players } = await playerStatsService.getLeaderboard(
      sortBy as string,
      order as 'asc' | 'desc',
      showBanned as 'show' | 'hide' | 'only',
      undefined,
      offsetNum,
      limitNum,
      query as string, // Pass the query string for name search
      filters
    );

    return res.json({ count: total, results: players, maxFields });
  } catch (error) {
    logger.error('Error fetching leaderboard:', error);
    return res.status(500).json({
      error: 'Failed to fetch leaderboard',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

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
