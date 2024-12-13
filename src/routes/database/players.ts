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
      players.map(async (player) => ({
        ...await enrichPlayerData(player),
        passes: undefined,
        discordUsername: player.discordUsername,
        discordId: player.discordId,
        discordAvatar: player.discordAvatar
      })),
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

router.put('/:id/discord', async (req: Request, res: Response) => {
  try {
    const {id} = req.params;
    const {discordId, discordUsername, discordAvatar} = req.body;

    const player = await Player.findByPk(id);
    if (!player) {
      return res.status(404).json({error: 'Player not found'});
    }

    await player.update({
      discordId,
      discordUsername,
      discordAvatar,
    });

    return res.json({message: 'Discord info updated successfully'});
  } catch (error) {
    console.error('Error updating player discord info:', error);
    return res.status(500).json({
      error: 'Failed to update player discord info',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

router.post('/create', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    
    // Check if player already exists
    const existingPlayer = await Player.findOne({
      where: {
        name: name
      }
    });

    if (existingPlayer) {
      return res.status(409).json({
        error: 'Player already exists',
        details: 'A player with this name already exists'
      });
    }

    // Create new player with required fields
    const player = await Player.create({
      name,
      country: 'XX', // Default country code
      isBanned: false,
      pfp: null,
      discordId: null,
      discordUsername: null,
      discordAvatar: null,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    const enrichedPlayer = await enrichPlayerData(player);
    return res.status(201).json(enrichedPlayer);
  } catch (error) {
    console.error('Error creating player:', error);
    return res.status(500).json({
      error: 'Failed to create player',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

export default router;
