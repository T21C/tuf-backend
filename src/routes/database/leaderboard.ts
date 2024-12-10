import { Request, Response, Router } from 'express';
import { validSortOptions } from '../../config/constants';
import leaderboardCache from '../../utils/LeaderboardCache';

const router: Router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const routeStart = performance.now();
    const {
      sortBy = 'rankedScore',
      order = 'desc',
      includeAllScores = 'false',
      showBanned = 'show'
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
      includeScores
    );

    // Filter based on ban status after getting from cache
    if (showBanned === 'only') {
      players = players.filter(player => player.isBanned);
    } else if (showBanned === 'hide') {
      players = players.filter(player => !player.isBanned);
    }

    const totalTime = performance.now() - routeStart;
    console.log(`[PERF] Total leaderboard route time: ${totalTime.toFixed(2)}ms`);

    return res.json(players);
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch leaderboard',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

export default router;
