import {Op} from 'sequelize';
import Player from '../../models/Player.js';
import Pass from '../../models/Pass.js';
import Level from '../../models/Level.js';
import Judgement from '../../models/Judgement.js';
import {enrichPlayerData} from '../../utils/PlayerEnricher.js';
import Difficulty from '../../models/Difficulty.js';
import fetch from 'node-fetch';
import {getIO} from '../../utils/socket.js';
import {Auth} from '../../middleware/auth.js';
import sequelize from '../../config/db.js';
import {updateWorldsFirstStatus} from './passes.js';
import {sseManager} from '../../utils/sse.js';
import User from '../../models/User.js';
import OAuthProvider from '../../models/OAuthProvider.js';
import {PlayerStatsService} from '../../services/PlayerStatsService.js';
import PlayerStats from '../../models/PlayerStats.js';
import {Router, Request, Response} from 'express';

const router: Router = Router();
const playerStatsService = PlayerStatsService.getInstance();

router.get('/', async (req: Request, res: Response) => {
  try {
    const players = await playerStatsService.getLeaderboard();
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
    
    // First check if player exists at all
    const playerExists = await Player.findByPk(id, {
      include: [
        {
          model: User,
          as: 'user',
          attributes: [
            'id',
            'username',
            'nickname',
            'avatarUrl',
            'isSuperAdmin',
            'isRater',
          ],
        },
      ],
    });

    if (!playerExists) {
      return res.status(404).json({error: 'Player not found'});
    }

    // Then get player with valid passes
    const player = await Player.findByPk(id, {
      include: [
        {
          model: Pass,
          as: 'passes',
          where: {
            isDeleted: false,
          },
          include: [
            {
              model: Level,
              as: 'level',
              where: {
                isDeleted: false,
                isHidden: false
              },
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
        {
          model: User,
          as: 'user',
          attributes: [
            'id',
            'username',
            'nickname',
            'avatarUrl',
            'isSuperAdmin',
            'isRater',
          ],
        },
      ],
    });

    const playerData = player || playerExists;

    // Wait for both enriched data and stats in parallel
    const [enrichedPlayer, playerStats] = await Promise.all([
      enrichPlayerData(playerData),
      playerStatsService.getPlayerStats(parseInt(id)),
    ]);

    // Calculate impact values for top 20 scores
    const uniquePasses = new Map();
    (playerData.passes || []).forEach(pass => {
      if (
        !uniquePasses.has(pass.levelId) ||
        (pass.scoreV2 || 0) > (uniquePasses.get(pass.levelId).scoreV2 || 0)
      ) {
        uniquePasses.set(pass.levelId, pass);
      }
    });

    const topScores = Array.from(uniquePasses.values())
      .filter((pass: any) => !pass.isDeleted && !pass.isDuplicate)
      .sort((a, b) => (b.scoreV2 || 0) - (a.scoreV2 || 0))
      .slice(0, 20)
      .map((pass, index) => ({
        id: pass.id,
        impact: (pass.scoreV2 || 0) * Math.pow(0.9, index),
      }));

    return res.json({
      ...enrichedPlayer,
      stats: playerStats,
      topScores,
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
          required: false,
          where: {
            isDeleted: false
          },
          include: [
            {
              model: Level,
              as: 'level',
              where: {
                isDeleted: false,
                isHidden: false
              },
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
  '/:userId/discord',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      const {userId} = req.params;
      const {id: discordId, username, avatar} = req.body;

      // Find player and any existing user with this Discord ID
      const [player, existingUserWithDiscord] = await Promise.all([
        Player.findByPk(userId, {
          include: [
            {
              model: User,
              as: 'user',
              include: [
                {
                  model: OAuthProvider,
                  as: 'providers',
                  where: {provider: 'discord'},
                  required: false,
                },
              ],
            },
          ],
          transaction,
        }),
        User.findOne({
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
          transaction,
        }),
      ]);

      if (!player) {
        await transaction.rollback();
        return res.status(404).json({error: 'Player not found'});
      }

      // If another user already has this Discord ID, prevent the update
      if (
        existingUserWithDiscord &&
        (!player.user || existingUserWithDiscord.id !== player.user.id)
      ) {
        await transaction.rollback();
        return res.status(409).json({
          error: 'Discord account already linked',
          details: 'This Discord account is already linked to another user',
        });
      }

      const profile = {
        id: discordId,
        username,
        avatar,
      };

      // Only update avatar if it's "none" or null
      const avatarUrl = profile.avatar === 'none' ? null : profile.avatar;

      // Update player's Discord info
      await player.update(
        {
          discordId: profile.id,
          discordUsername: profile.username,
          pfp: avatarUrl || player.pfp, // Only update pfp if new avatar is available
        },
        {transaction},
      );

      // Handle OAuth provider update/creation if player has a user
      if (player.user) {
        // Update user's avatarUrl only if new avatar is available
        if (avatarUrl) {
          await player.user.update(
            {
              avatarUrl,
            },
            {transaction},
          );
        }

        const discordProvider = player.user.providers?.[0];
        const providerData = {
          provider: 'discord',
          providerId: profile.id,
          profile: profile,
        };

        if (discordProvider) {
          // Update existing provider
          await discordProvider.update(providerData, {transaction});
        } else {
          // Create new provider
          await OAuthProvider.create(
            {
              ...providerData,
              userId: player.user.id,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            {transaction},
          );
        }
      }

      await transaction.commit();

      // Force cache update and broadcast changes
      if (req.leaderboardCache) await req.leaderboardCache.forceUpdate();
      const io = getIO();
      io.emit('leaderboardUpdated');
      sseManager.broadcast({type: 'playerUpdate'});

      return res.json({message: 'Discord info updated successfully'});
    } catch (error) {
      await transaction.rollback();
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
  async (req: Request, res: Response) => {
    try {
      const {id} = req.params;

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
  async (req: Request, res: Response) => {
    try {
      const {name} = req.body;

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
        isSubmissionsPaused: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

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

router.get(
  '/:id/discord/:discordId',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
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
  },
);

router.put(
  '/:id/discord/:discordId',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      const {id, discordId} = req.params;
      const {username, avatar} = req.body;

      const player = await Player.findByPk(id, {
        include: [
          {
            model: User,
            as: 'user',
            include: [
              {
                model: OAuthProvider,
                as: 'providers',
                where: {provider: 'discord'},
                required: false,
              },
            ],
          },
        ],
        transaction,
      });

      if (!player) {
        await transaction.rollback();
        return res.status(404).json({error: 'Player not found'});
      }

      const avatarUrl = `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.png`;
      const profile = {
        id: discordId,
        username,
        avatar,
        avatarUrl,
      };

      await player.update(
        {
          discordId,
          discordUsername: username,
          discordAvatarId: avatar,
          discordAvatar: avatarUrl,
          pfp: avatarUrl, // Update player's pfp
        },
        {transaction},
      );

      // Handle OAuth provider update/creation if player has a user
      if (player.user) {
        // Update user's avatarUrl
        await player.user.update(
          {
            avatarUrl,
          },
          {transaction},
        );

        const discordProvider = player.user.providers?.[0];
        const providerData = {
          provider: 'discord',
          providerId: discordId,
          profile: profile, // Store the complete Discord profile
        };

        if (discordProvider) {
          // Update existing provider
          await discordProvider.update(providerData, {transaction});
        } else {
          // Create new provider
          await OAuthProvider.create(
            {
              ...providerData,
              userId: player.user.id,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            {transaction},
          );
        }
      }

      await transaction.commit();

      // Force cache update and broadcast changes
      if (req.leaderboardCache) await req.leaderboardCache.forceUpdate();
      const io = getIO();
      io.emit('leaderboardUpdated');
      sseManager.broadcast({type: 'playerUpdate'});

      return res.json({
        message: 'Discord info updated successfully',
        discordInfo: profile,
      });
    } catch (error) {
      await transaction.rollback();
      console.error('Error updating Discord info:', error);
      return res.status(500).json({
        error: 'Failed to update Discord info',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.put(
  '/:id/name',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const {id} = req.params;
      const {name} = req.body;

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
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const {id} = req.params;
      const {country} = req.body;

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
async function updateAffectedLevelsWorldsFirst(
  playerId: number,
  transaction?: any,
) {
  // Find all levels where this player has passes
  const affectedLevels = await Pass.findAll({
    where: {
      playerId,
      isWorldsFirst: true,
    },
    attributes: ['levelId'],
    group: ['levelId'],
    transaction,
  });

  // Update world's first status for each affected level
  for (const level of affectedLevels) {
    await updateWorldsFirstStatus(level.levelId, transaction);
  }
}

// Update the ban/unban endpoint
router.patch(
  '/:id/ban',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      const {id} = req.params;
      const {isBanned} = req.body;

      const player = await Player.findByPk(id, {transaction});
      if (!player) {
        await transaction.rollback();
        return res.status(404).json({error: 'Player not found'});
      }

      await player.update({isBanned}, {transaction});

      // Update world's first status for all affected levels
      await updateAffectedLevelsWorldsFirst(player.id, transaction);

      await transaction.commit();

      // Force cache update and broadcast changes
      if (req.leaderboardCache) await req.leaderboardCache.forceUpdate();
      sseManager.broadcast({type: 'playerUpdate'});

      return res.json({
        message: `Player ${isBanned ? 'banned' : 'unbanned'} successfully`,
        player,
      });
    } catch (error) {
      await transaction.rollback();
      console.error('Error updating player ban status:', error);
      return res
        .status(500)
        .json({error: 'Failed to update player ban status'});
    }
  },
);

// Add this new endpoint after the ban endpoint
router.patch(
  '/:id/pause-submissions',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      const {id} = req.params;
      const {isSubmissionsPaused} = req.body;

      const player = await Player.findByPk(id, {transaction});
      if (!player) {
        await transaction.rollback();
        return res.status(404).json({error: 'Player not found'});
      }

      await player.update({isSubmissionsPaused}, {transaction});
      await transaction.commit();

      // Force cache update and broadcast changes
      if (req.leaderboardCache) await req.leaderboardCache.forceUpdate();
      sseManager.broadcast({type: 'playerUpdate'});

      return res.json({
        message: `Player submissions ${isSubmissionsPaused ? 'paused' : 'resumed'} successfully`,
        player,
      });
    } catch (error) {
      await transaction.rollback();
      console.error('Error updating player submission pause status:', error);
      return res
        .status(500)
        .json({error: 'Failed to update player submission pause status'});
    }
  },
);

router.post(
  '/:id/merge',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      const {id} = req.params;
      const {targetPlayerId} = req.body;

      // Find both players with their associated users and OAuth providers
      const sourcePlayer = await Player.findByPk(id, {
        include: [
          {
            model: User,
            as: 'user',
            include: [
              {
                model: OAuthProvider,
                as: 'oauthProviders',
              },
            ],
          },
        ],
        transaction,
      });

      const targetPlayer = await Player.findByPk(targetPlayerId, {
        include: [
          {
            model: User,
            as: 'user',
            include: [
              {
                model: OAuthProvider,
                as: 'oauthProviders',
              },
            ],
          },
        ],
        transaction,
      });

      if (!sourcePlayer || !targetPlayer) {
        await transaction.rollback();
        return res.status(404).json({error: 'One or both players not found'});
      }

      // Update all passes to point to the target player
      await Pass.update(
        {playerId: targetPlayer.id},
        {
          where: {playerId: sourcePlayer.id},
          transaction,
        },
      );

      // If source player has a user, update OAuth providers and reassign user to target player
      if (sourcePlayer.user) {
        if (targetPlayer.user) {
          // If target has a user, move OAuth providers and delete source user
          await OAuthProvider.update(
            {userId: targetPlayer.user.id},
            {
              where: {userId: sourcePlayer.user.id},
              transaction,
            },
          );
          await User.destroy({
            where: {id: sourcePlayer.user.id},
            transaction,
          });
        } else {
          // If target has no user, reassign source user to target player
          await User.update(
            {playerId: targetPlayer.id},
            {
              where: {id: sourcePlayer.user.id},
              transaction,
            },
          );
        }
      }

      // Delete player stats first to avoid constraint issues
      await PlayerStats.destroy({
        where: {playerId: sourcePlayer.id},
        transaction,
      });

      // Delete the source player
      await Player.destroy({
        where: {id: sourcePlayer.id},
        transaction,
      });

      await transaction.commit();

      // Update stats for target player
      await playerStatsService.updatePlayerStats(targetPlayer.id);

      const io = getIO();
      io.emit('leaderboardUpdated');

      return res.json({message: 'Players merged successfully'});
    } catch (error) {
      await transaction.rollback();
      console.error('Error merging players:', error);
      return res.status(500).json({
        error: 'Failed to merge players',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

// Add profile request endpoint
router.post('/request', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    const { name, discordId, country } = req.body;

    // Validate required fields
    if (!name || !discordId || !country) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if player already exists with this name
    const existingPlayer = await Player.findOne({
      where: {
        name: {
          [Op.iLike]: name
        }
      }
    });

    if (existingPlayer) {
      return res.status(409).json({ error: 'Player with this name already exists' });
    }

    // Create new player
    const player = await Player.create({
      name,
      country,
      isBanned: false,
      isSubmissionsPaused: false,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    return res.status(201).json({
      id: player.id,
      name: player.name
    });
  } catch (error) {
    console.error('Error creating player profile:', error);
    return res.status(500).json({ error: 'Failed to create player profile' });
  }
});

export default router;
