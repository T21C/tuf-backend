import {Request, Response, Router} from 'express';
import {validSortOptions} from '../../config/constants.js';
import {PlayerStatsService} from '../../services/PlayerStatsService.js';
import User from '../../models/auth/User.js';
import OAuthProvider from '../../models/auth/OAuthProvider.js';
import { logger } from '../../services/LoggerService.js';

const router: Router = Router();
const playerStatsService = PlayerStatsService.getInstance();

router.get('/', async (req: Request, res: Response) => {
  try {
    const {
      sortBy = 'rankedScore',
      order = 'desc',
      showBanned = 'show',
      query,
      offset = '0',
      limit = '30'
    } = req.query;

    if (!validSortOptions.includes(sortBy as string)) {
      return res.status(400).json({
        error: `Invalid sortBy option. Valid options are: ${validSortOptions.join(', ')}`,
      });
    }

    // Parse offset and limit to numbers
    const offsetNum = Math.max(0, parseInt(offset as string) || 0);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit as string) || 30));

    // If there's a query and it starts with #, treat it as a Discord ID search
    if (query && typeof query === 'string' && query.startsWith('#')) {
      const idQuery = parseInt(query.slice(1)); // Remove the # prefix
      if (isNaN(idQuery) || idQuery < 1) {
        return res.json({ count: 0, results: [] });
      }
      // Find the user with this Discord OAuth provider
      let userWithDiscord = await User.findOne({
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
      let lookupId = userWithDiscord?.playerId || idQuery;
      const { total, players } = await playerStatsService.getLeaderboard(
        sortBy as string,
        order as 'asc' | 'desc',
        showBanned as 'show' | 'hide' | 'only',
        lookupId,
        offsetNum,
        limitNum
      );
      return res.json({ count: total, results: players });
    }


    if (query && typeof query === 'string' && query.startsWith('@')) {
      const idQuery = query.slice(1); // Remove the @ prefix

      // Find the user with this Discord OAuth provider
      let userWithDiscord = await User.findOne({
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
        limitNum
      );
      return res.json({ count: total, results: players });
    }

    // Regular leaderboard fetch without Discord ID filter
    const { total, players } = await playerStatsService.getLeaderboard(
      sortBy as string,
      order as 'asc' | 'desc',
      showBanned as 'show' | 'hide' | 'only',
      undefined,
      offsetNum,
      limitNum,
      query as string // Pass the query string for name search
    );

    return res.json({ count: total, results: players });
  } catch (error) {
    logger.error('Error fetching leaderboard:', error);
    return res.status(500).json({
      error: 'Failed to fetch leaderboard',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
