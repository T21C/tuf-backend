import {Request, Response, Router} from 'express';
import {validSortOptions} from '../../config/constants.js';
import {PlayerStatsService} from '../../services/PlayerStatsService.js';
import User from '../../models/User.js';
import OAuthProvider from '../../models/OAuthProvider.js';

const router: Router = Router();
const playerStatsService = PlayerStatsService.getInstance();

router.get('/', async (req: Request, res: Response) => {
  try {
    const {
      sortBy = 'rankedScore',
      order = 'desc',
      showBanned = 'show',
      query,
    } = req.query;

    if (!validSortOptions.includes(sortBy as string)) {
      return res.status(400).json({
        error: `Invalid sortBy option. Valid options are: ${validSortOptions.join(', ')}`,
      });
    }

    // If there's a query and it starts with #, treat it as a Discord ID search
    if (query && typeof query === 'string' && query.startsWith('#')) {
      const discordId = query.slice(1); // Remove the # prefix

      // Find the user with this Discord OAuth provider
      const userWithDiscord = await User.findOne({
        include: [
          {
            model: OAuthProvider,
            as: 'providers',
            where: {
              provider: 'discord',
              providerId: discordId,
            },
          },
        ],
      });

      if (userWithDiscord) {
        // Get player stats for this specific user's player
        const playerStats = await playerStatsService.getLeaderboard(
          sortBy as string,
          order as 'asc' | 'desc',
          showBanned as 'show' | 'hide' | 'only',
          userWithDiscord.playerId, // Pass the playerId directly
        );
        return res.json(playerStats);
      }

      // If no user found with that Discord ID, return empty array
      return res.json([]);
    }

    // Regular leaderboard fetch without Discord ID filter
    const players = await playerStatsService.getLeaderboard(
      sortBy as string,
      order as 'asc' | 'desc',
      showBanned as 'show' | 'hide' | 'only',
    );

    return res.json(players);
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    return res.status(500).json({
      error: 'Failed to fetch leaderboard',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
