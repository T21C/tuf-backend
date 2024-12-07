import { Request, Response, Router } from 'express';
import { Op } from 'sequelize';
import { validSortOptions } from '../../config/constants';
import Player from '../../models/Player';
import Pass from '../../models/Pass';
import Level from '../../models/Level';
import Judgement from '../../models/Judgement';
import { enrichPlayerData } from '../../utils/PlayerEnricher';

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

    if (!validSortOptions.includes(sortBy as string)) {
      return res.status(400).json({
        error: `Invalid sortBy option. Valid options are: ${validSortOptions.join(', ')}`,
      });
    }

    // Build where clause based on ban status
    const whereClause: any = {};
    if (showBanned === 'only') {
      whereClause.isBanned = true;
    } else if (showBanned === 'hide') {
      whereClause.isBanned = false;
    }

    // Get players with their passes and related data
    const players = await Player.findAll({
      where: whereClause,
      include: [{
        model: Pass,
        as: 'playerPasses',
        include: [{
          model: Level,
          attributes: ['id', 'song', 'artist', 'pguDiff', 'baseScore']
        },
        {
          model: Judgement,
          attributes: ['earlyDouble', 'earlySingle', 'ePerfect', 'perfect', 'lPerfect', 'lateSingle', 'lateDouble']
        }]
      }]
    });

    // Enrich player data with calculated fields
    let enrichedPlayers = await Promise.all(
      players.map(player => enrichPlayerData(player))
    );

    // Sort players based on the requested field
    enrichedPlayers.sort((a, b) => {
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

    // Remove passes if not requested
    if (includeAllScores === 'false') {
      enrichedPlayers = enrichedPlayers.map(player => {
        const { playerPasses, ...rest } = player;
        return rest;
      });
    }

    const totalTime = performance.now() - routeStart;
    console.log(`[PERF] Total leaderboard route time: ${totalTime.toFixed(2)}ms`);

    return res.json(enrichedPlayers);
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch leaderboard',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

export default router;
