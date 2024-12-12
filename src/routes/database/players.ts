import {Request, Response, Router} from 'express';
import {Op} from 'sequelize';
import Player from '../../models/Player';
import Pass from '../../models/Pass';
import Level from '../../models/Level';
import Judgement from '../../models/Judgement';
import {enrichPlayerData} from '../../utils/PlayerEnricher';
import leaderboardCache from '../../utils/LeaderboardCache';
import Difficulty from '../../models/Difficulty';

const router: Router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const {includeScores = 'true'} = req.query;
    const players = await leaderboardCache.get(
      'rankedScore',
      'desc',
      includeScores === 'true',
    );
    return res.json(players);
  } catch (error) {
    console.error('Error fetching players:', error);
    return res.status(500).json({
      error: 'Failed to fetch players',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const {id} = req.params;

    const player = await Player.findByPk(id, {
      include: [
        {
          model: Pass,
          as: 'passes',
          include: [
            {
              model: Level,
              as: 'level',
              include: [
                {
                  model: Difficulty,
                  as: 'difficulty',
                },
              ],
            },
            {
              model: Judgement,
              as: 'judgements',
            },
          ],
        },
      ],
    });

    if (!player) {
      return res.status(404).json({error: 'Player not found'});
    }

    const enrichedPlayer = await enrichPlayerData(player);
    return res.json({
      ...enrichedPlayer,
      ranks: await leaderboardCache.getRanks(player.id),
    });
  } catch (error) {
    console.error('Error fetching player:', error);
    return res.status(500).json({
      error: 'Failed to fetch player',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get('/search/:name', async (req: Request, res: Response) => {
  try {
    const {name} = req.params;
    const players = await Player.findAll({
      where: {
        name: {
          [Op.like]: `%${name}%`,
        },
      },
      include: [
        {
          model: Pass,
          as: 'passes',
          include: [
            {
              model: Level,
              as: 'level',
            },
            {
              model: Judgement,
              as: 'judgements',
            },
          ],
        },
      ],
    });

    const enrichedPlayers = await Promise.all(
      players.map(player => enrichPlayerData(player)),
    );

    return res.json(enrichedPlayers);
  } catch (error) {
    console.error('Error searching players:', error);
    return res.status(500).json({
      error: 'Failed to search players',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
