import express, {Request, Response, Router} from 'express';
import {validSortOptions} from '../../config/constants.js';
import {Cache} from '../../utils/cacheManager.js';

const router: Router = express.Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const routeStart = performance.now();
    const {
      sortBy = 'rankedScore',
      order = 'desc',
      includeAllScores = 'false',
      showBanned = 'show'
    } = req.query;

    if (!validSortOptions.includes(sortBy as string)) {
      return res.status(400).json({
        error: `Invalid sortBy option. Valid options are: ${validSortOptions.join(', ')}`,
      });
    }

    // Get data from cache
    const leaderboardData = Cache.get('fullPlayerList');
    const pfpList = Cache.get('pfpList');

    if (!Array.isArray(leaderboardData)) {
      return res.status(500).json({error: 'Invalid leaderboard data'});
    }

    // Filter players based on showBanned parameter
    const filteredData = 
        showBanned === 'only'
        ? leaderboardData.filter((player: any) => player.isBanned)
        : showBanned === 'hide'
          ? leaderboardData.filter((player: any) => !player.isBanned)
          : leaderboardData;

    // Sorting logic
    const sortedData = filteredData.sort((a: any, b: any) => {
      const valueA = a[sortBy as keyof typeof a];
      const valueB = b[sortBy as keyof typeof b];

      if (valueA === undefined || valueB === undefined) {
        return 0;
      }

      if (order === 'asc') {
        return valueA > valueB ? 1 : -1;
      } else {
        return valueA < valueB ? 1 : -1;
      }
    });

    // Map response data
    const responseData = sortedData.map((player: any) => {
      const enrichedPlayer = {
        ...player,
        pfp: pfpList[player.player] || null
      };

      if (includeAllScores === 'false' && enrichedPlayer.allScores) {
        const {allScores, ...rest} = enrichedPlayer;
        return rest;
      }

      return enrichedPlayer;
    });

    const totalTime = performance.now() - routeStart;
    console.log(`[PERF] Total leaderboard route time: ${totalTime.toFixed(2)}ms`);

    return res.json(responseData);
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch leaderboard',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

export default router;
