import {Request, Response, Router} from 'express';
import {validSortOptions} from '../../config/constants';
import {IPlayer} from '../../interfaces/models';
import {Cache, LeaderboardCache} from '../../middleware/cache';
const router: Router = Router();

router.get('/', Cache.leaderboard(), async (req: Request, res: Response) => {
  try {
    const leaderboardCache = req.leaderboardCache as LeaderboardCache;
    if (!leaderboardCache) {
      throw new Error('LeaderboardCache not initialized');
    }

    const routeStart = performance.now();
    const {
      sortBy = 'rankedScore',
      order = 'desc',
      includeAllScores = 'false',
      showBanned = 'show',
    } = req.query;

    const includeScores = String(includeAllScores).toLowerCase() === 'true';

    if (!validSortOptions.includes(sortBy as string)) {
      return res.status(400).json({
        error: `Invalid sortBy option. Valid options are: ${validSortOptions.join(', ')}`,
      });
    }

    // Get cached leaderboard data
    let players = await leaderboardCache.get(
      sortBy as string,
      order as string,
      includeScores,
    );

    // Filter based on ban status after getting from cache
    if (showBanned === 'only') {
      players = players.filter((player: IPlayer) => player.isBanned);
    } else if (showBanned === 'hide') {
      players = players.filter((player: IPlayer) => !player.isBanned);
    }

    const totalTime = performance.now() - routeStart;

    players = await Promise.all(players.map(async (player: IPlayer) => ({
      ...player,
      rank: (await leaderboardCache.getRanks(player.id)).rankedScoreRank,
    })));
    
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
