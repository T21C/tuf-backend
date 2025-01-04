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
import { Auth } from '../../middleware/auth';
import sequelize from '../../config/db';
import { updateWorldsFirstStatus } from './passes';
import { sseManager } from '../../utils/sse';
import User from '../../models/User';
import OAuthProvider from '../../models/OAuthProvider';

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
  Auth.superAdmin(),
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


router.delete(
  '/:id/discord',
  Auth.superAdmin(),
  Cache.leaderboard(),
  async (req: Request, res: Response) => {
    try {
      const {id} = req.params;
      const leaderboardCache = req.leaderboardCache;
      if (!leaderboardCache) {
        throw new Error('LeaderboardCache not initialized');
      }

      const player = await Player.findByPk(id);
      if (!player) {
        return res.status(404).json({error: 'Player not found'});
      }

      await player.update({
        discordId: null,
        discordUsername: null,
        discordAvatar: null,
        discordAvatarId: null,
      });

      await leaderboardCache.forceUpdate();
      const io = getIO();
      io.emit('leaderboardUpdated');

      return res.json({message: 'Discord info removed successfully'});
    } catch (error) {
      console.error('Error removing player discord info:', error);
      return res.status(500).json({
        error: 'Failed to remove player discord info',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);


router.post(
  '/create',
  Auth.superAdmin(),
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

router.get('/:id/discord/:discordId', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const {discordId} = req.params;

    // Fetch Discord user data
    const response = await fetch(
      `https://discord.com/api/v10/users/${discordId}`,
      {
        headers: {
          Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
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

    return res.json({
      message: 'Discord info fetched successfully',
      discordUser: {
        id: discordUser.id,
        username: discordUser.username,
        avatar: discordUser.avatar,
        avatarUrl: `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`,
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
  '/:id/discord/:discordId',
  Cache.leaderboard(),
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const {id, discordId} = req.params;
      const {username, avatar} = req.body;
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
        discordUsername: username,
        discordAvatarId: avatar,
        discordAvatar: `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.png`,
      });

      await leaderboardCache.forceUpdate();
      const io = getIO();
      io.emit('leaderboardUpdated');

      return res.json({
        message: 'Discord info updated successfully',
        discordInfo: {
          id: discordId,
          username,
          avatar,
          avatarUrl: `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.png`,
        },
      });
    } catch (error) {
      console.error('Error updating Discord info:', error);
      return res.status(500).json({
        error: 'Failed to update Discord info',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.put('/:id/name', Auth.superAdmin(), Cache.leaderboard(), async (req: Request, res: Response) => {
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

router.put('/:id/country', Auth.superAdmin(), Cache.leaderboard(), async (req: Request, res: Response) => {
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

// Add helper function to update all affected levels
async function updateAffectedLevelsWorldsFirst(playerId: number, transaction?: any) {
  // Find all levels where this player has passes
  const affectedLevels = await Pass.findAll({
    where: {
      playerId,
      isWorldsFirst: true
    },
    attributes: ['levelId'],
    group: ['levelId'],
    transaction
  });

  // Update world's first status for each affected level
  for (const level of affectedLevels) {
    await updateWorldsFirstStatus(level.levelId, transaction);
  }
}

// Update the ban/unban endpoint
router.patch('/:id/ban', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;
    const { isBanned } = req.body;

    const player = await Player.findByPk(id, { transaction });
    if (!player) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Player not found' });
    }

    await player.update({ isBanned }, { transaction });

    // Update world's first status for all affected levels
    await updateAffectedLevelsWorldsFirst(player.id, transaction);

    await transaction.commit();

    // Force cache update and broadcast changes
    if (req.leaderboardCache) await req.leaderboardCache.forceUpdate();
    sseManager.broadcast({ type: 'playerUpdate' });

    return res.json({ 
      message: `Player ${isBanned ? 'banned' : 'unbanned'} successfully`,
      player 
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error updating player ban status:', error);
    return res.status(500).json({ error: 'Failed to update player ban status' });
  }
});

router.post('/:id/merge', Auth.superAdmin(), Cache.leaderboard(), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { targetPlayerId } = req.body;
    const leaderboardCache = req.leaderboardCache;
    if (!leaderboardCache) {
      throw new Error('LeaderboardCache not initialized');
    }

    // Find both players with their associated users and OAuth providers
    const sourcePlayer = await Player.findByPk(id, {
      include: [{
        model: User,
        as: 'user',
        include: [{
          model: OAuthProvider,
          as: 'providers'
        }]
      }]
    });
    const targetPlayer = await Player.findByPk(targetPlayerId, {
      include: [{
        model: User,
        as: 'user',
        include: [{
          model: OAuthProvider,
          as: 'providers'
        }]
      }]
    });

    if (!sourcePlayer) {
      return res.status(404).json({ error: 'Source player not found' });
    }
    if (!targetPlayer) {
      return res.status(404).json({ error: 'Target player not found' });
    }

    // Get all passes for the source player
    const passes = await Pass.findAll({
      where: {
        playerId: sourcePlayer.id
      }
    });

    // Start a transaction
    const t = await sequelize.transaction();

    try {
      // Update all passes to point to the target player
      await Promise.all(passes.map(pass => 
        pass.update({ playerId: targetPlayer.id }, { transaction: t })
      ));

      // Handle user associations
      if (sourcePlayer.user && !targetPlayer.user) {
        // If source has a user but target doesn't, transfer the user and its providers
        await sourcePlayer.user.update({ playerId: targetPlayer.id }, { transaction: t });
      } else if (sourcePlayer.user && targetPlayer.user) {
        // If both have users, transfer providers from source to target if they don't exist
        const sourceProviders = sourcePlayer.user.providers || [];
        const targetProviders = targetPlayer.user.providers || [];
        const targetProviderIds = new Set(targetProviders.map(p => p.providerId));

        // Transfer providers that don't exist in target
        await Promise.all(sourceProviders
          .filter(provider => !targetProviderIds.has(provider.providerId))
          .map(provider => provider.update({ userId: targetPlayer.user!.id }, { transaction: t }))
        );

        // Delete the source user
        await sourcePlayer.user.destroy({ transaction: t });
      }

      // Delete the source player
      await sourcePlayer.destroy({ transaction: t });

      // Commit the transaction
      await t.commit();

      // Force cache update
      await leaderboardCache.forceUpdate();
      const io = getIO();
      io.emit('leaderboardUpdated');

      return res.json({ 
        message: 'Player merged successfully',
        targetPlayer: await enrichPlayerData(targetPlayer)
      });
    } catch (error) {
      // If anything fails, roll back the transaction
      await t.rollback();
      throw error;
    }
  } catch (error) {
    console.error('Error merging players:', error);
    return res.status(500).json({
      error: 'Failed to merge players',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
