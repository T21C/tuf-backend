import {Request, Response, Router} from 'express';
import {Op} from 'sequelize';
import Player from '../../models/Player';
import Pass from '../../models/Pass';
import Level from '../../models/Level';
import Judgement from '../../models/Judgement';
import {enrichPlayerData} from '../../utils/PlayerEnricher';
import Difficulty from '../../models/Difficulty';
import fetch from 'node-fetch';
import {getIO} from '../../utils/socket';
import {Cache} from '../../middleware/cache';

const router: Router = Router();

router.get('/', Cache.leaderboard(), async (req: Request, res: Response) => {
  try {
    const {includeScores = 'true'} = req.query;
    const leaderboardCache = req.leaderboardCache;
    if (!leaderboardCache) {
      throw new Error('LeaderboardCache not initialized');
    }
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

router.get('/:id', Cache.leaderboard(), async (req: Request, res: Response) => {
  try {
    const {id} = req.params;
    const leaderboardCache = req.leaderboardCache;
    if (!leaderboardCache) {
      throw new Error('LeaderboardCache not initialized');
    }
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
    if (!leaderboardCache) {
      throw new Error('LeaderboardCache not initialized');
    }
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
      players.map(async player => ({
        ...(await enrichPlayerData(player)),
        passes: undefined,
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

router.put(
  '/:id/discord',
  Cache.leaderboard(),
  async (req: Request, res: Response) => {
    try {
      const {id} = req.params;
      const {discordId, discordUsername, discordAvatar} = req.body;
      const leaderboardCache = req.leaderboardCache;
      if (!leaderboardCache) {
        throw new Error('LeaderboardCache not initialized');
      }

      const player = await Player.findByPk(id);
      if (!player) {
        return res.status(404).json({error: 'Player not found'});
      }

      await player.update({
        discordId,
        discordUsername,
        discordAvatar,
        discordAvatarId: discordAvatar.split('/').pop(),
      });

      await leaderboardCache.forceUpdate();
      const io = getIO();
      io.emit('leaderboardUpdated');

      return res.json({message: 'Discord info updated successfully'});
    } catch (error) {
      console.error('Error updating player discord info:', error);
      return res.status(500).json({
        error: 'Failed to update player discord info',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.post(
  '/create',
  Cache.leaderboard(),
  async (req: Request, res: Response) => {
    try {
      const {name} = req.body;
      const leaderboardCache = req.leaderboardCache;
      if (!leaderboardCache) {
        throw new Error('LeaderboardCache not initialized');
      }

      // Check if player already exists
      const existingPlayer = await Player.findOne({
        where: {
          name: name,
        },
      });

      if (existingPlayer) {
        return res.status(409).json({
          error: 'Player already exists',
          details: 'A player with this name already exists',
        });
      }

      // Create new player with required fields
      const player = await Player.create({
        name,
        country: 'XX', // Default country code
        isBanned: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Force cache update
      if (!leaderboardCache) {
        throw new Error('LeaderboardCache not initialized');
      }
      await leaderboardCache.forceUpdate();
      const io = getIO();
      io.emit('leaderboardUpdated');

      const enrichedPlayer = await enrichPlayerData(player);
      return res.status(201).json(enrichedPlayer);
    } catch (error) {
      console.error('Error creating player:', error);
      return res.status(500).json({
        error: 'Failed to create player',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.get('/:id/discord/:discordId', async (req: Request, res: Response) => {
  try {
    const {id, discordId} = req.params;

    // Fetch Discord user data
    const response = await fetch(
      `https://discord.com/api/v10/users/${discordId}`,
      {
        headers: {
          Authorization: `Bot ${process.env.BOT_TOKEN}`,
        },
      },
    );
    if (!response.ok) {
      return res.status(response.status).json({
        error: 'Failed to fetch Discord user',
        details: `Discord API returned status ${response.status}`,
      });
    }

    const discordUser: {id: string; username: string; avatar: string} =
      (await response.json()) as any;

    // Update player with Discord info
    const player = await Player.findByPk(id);
    if (!player) {
      return res.status(404).json({error: 'Player not found'});
    }

    await player.update({
      discordId: discordUser.id,
      discordUsername: discordUser.username,
      discordAvatarId: discordUser.avatar,
      discordAvatar: `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`,
    });

    return res.json({
      message: 'Discord info updated successfully',
      discordUser: {
        id: discordUser.id,
        username: discordUser.username,
        avatar: discordUser.avatar,
      },
    });
  } catch (error) {
    console.error('Error fetching Discord user:', error);
    return res.status(500).json({
      error: 'Failed to fetch Discord user',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

router.put(
  '/:id/name',
  Cache.leaderboard(),
  async (req: Request, res: Response) => {
    try {
      const {id} = req.params;
      const {name} = req.body;
      const leaderboardCache = req.leaderboardCache;
      if (!leaderboardCache) {
        throw new Error('LeaderboardCache not initialized');
      }

      if (!name || name.trim().length === 0) {
        return res.status(400).json({
          error: 'Invalid name',
          details: 'Name cannot be empty',
        });
      }

      // Check if name is already taken
      const existingPlayer = await Player.findOne({
        where: {
          name: name,
          id: {[Op.ne]: id}, // Exclude current player
        },
      });

      if (existingPlayer) {
        return res.status(409).json({
          error: 'Name already taken',
          details: 'Another player is already using this name',
        });
      }

      const player = await Player.findByPk(id);
      if (!player) {
        return res.status(404).json({error: 'Player not found'});
      }

      await player.update({name});

      // Force cache update
      if (!leaderboardCache) {
        throw new Error('LeaderboardCache not initialized');
      }
      await leaderboardCache.forceUpdate();
      const io = getIO();
      io.emit('leaderboardUpdated');

      return res.json({
        message: 'Player name updated successfully',
        name: name,
      });
    } catch (error) {
      console.error('Error updating player name:', error);
      return res.status(500).json({
        error: 'Failed to update player name',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.put(
  '/:id/country',
  Cache.leaderboard(),
  async (req: Request, res: Response) => {
    try {
      const {id} = req.params;
      const {country} = req.body;
      const leaderboardCache = req.leaderboardCache;
      if (!leaderboardCache) {
        throw new Error('LeaderboardCache not initialized');
      }

      if (!country || country.trim().length !== 2) {
        return res.status(400).json({
          error: 'Invalid country code',
          details: 'Country code must be exactly 2 characters',
        });
      }

      const player = await Player.findByPk(id);
      if (!player) {
        return res.status(404).json({error: 'Player not found'});
      }

      await player.update({country: country.toUpperCase()});

      // Force cache update
      if (!leaderboardCache) {
        throw new Error('LeaderboardCache not initialized');
      }
      await leaderboardCache.forceUpdate();
      const io = getIO();
      io.emit('leaderboardUpdated');

      return res.json({
        message: 'Player country updated successfully',
        country: country.toUpperCase(),
      });
    } catch (error) {
      console.error('Error updating player country:', error);
      return res.status(500).json({
        error: 'Failed to update player country',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.put(
  '/:id/ban',
  Cache.leaderboard(),
  async (req: Request, res: Response) => {
    try {
      const {id} = req.params;
      const {isBanned} = req.body;
      const leaderboardCache = req.leaderboardCache;
      if (!leaderboardCache) {
        throw new Error('LeaderboardCache not initialized');
      }

      const player = await Player.findByPk(id);
      if (!player) {
        return res.status(404).json({error: 'Player not found'});
      }

      await player.update({isBanned});

      // Force cache update
      if (!leaderboardCache) {
        throw new Error('LeaderboardCache not initialized');
      }
      await leaderboardCache.forceUpdate();
      const io = getIO();
      io.emit('leaderboardUpdated');

      return res.json({
        message: `Player ${isBanned ? 'banned' : 'unbanned'} successfully`,
        isBanned,
      });
    } catch (error) {
      console.error('Error updating player ban status:', error);
      return res.status(500).json({
        error: 'Failed to update player ban status',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

export default router;
