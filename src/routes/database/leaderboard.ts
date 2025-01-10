import {Request, Response, Router} from 'express';
import {validSortOptions} from '../../config/constants';
import {PlayerStatsService} from '../../services/PlayerStatsService';

const router: Router = Router();
const playerStatsService = PlayerStatsService.getInstance();

router.get('/', async (req: Request, res: Response) => {
  try {
    const {
      sortBy = 'rankedScore',
      order = 'desc',
      showBanned = 'show',
    } = req.query;

    if (!validSortOptions.includes(sortBy as string)) {
      return res.status(400).json({
        error: `Invalid sortBy option. Valid options are: ${validSortOptions.join(', ')}`,
      });
    }

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
