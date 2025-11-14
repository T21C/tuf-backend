import {Op} from 'sequelize';
import Player from '../../models/players/Player.js';
import Pass from '../../models/passes/Pass.js';
import {getIO} from '../../utils/server/socket.js';
import {Auth} from '../../middleware/auth.js';
import sequelize from '../../config/db.js';
import {updateWorldsFirstStatus} from './passes/index.js';
import {sseManager} from '../../utils/server/sse.js';
import User from '../../models/auth/User.js';
import OAuthProvider from '../../models/auth/OAuthProvider.js';
import {PlayerStatsService} from '../../services/PlayerStatsService.js';
import PlayerStats from '../../models/players/PlayerStats.js';
import {Router, Request, Response} from 'express';
import {fetchDiscordUserInfo} from '../../utils/auth/discord.js';
import { escapeForMySQL } from '../../utils/data/searchHelpers.js';
import PlayerModifier from '../../models/players/PlayerModifier.js';
import { ModifierService } from '../../services/ModifierService.js';
import { logger } from '../../services/LoggerService.js';
import Creator from '../../models/credits/Creator.js';
import { PassSubmission } from '../../models/submissions/PassSubmission.js';
import LevelSubmission from '../../models/submissions/LevelSubmission.js';
import { AuditLog } from '../../models/index.js';
import UsernameChange from '../../models/auth/UsernameChange.js';
import LevelRerateHistory from '../../models/levels/LevelRerateHistory.js';
import RatingAccuracyVote from '../../models/levels/RatingAccuracyVote.js';
import RatingDetail from '../../models/levels/RatingDetail.js';
import { safeTransactionRollback } from '../../utils/Utility.js';
import { permissionFlags } from '../../config/constants.js';
import { hasFlag, setUserPermissionAndSave, wherePermission } from '../../utils/auth/permissionUtils.js';
import { serializePlayer } from '../../utils/server/jsonHelpers.js';

const router: Router = Router();
const playerStatsService = PlayerStatsService.getInstance();
const modifierService = ModifierService.getInstance();


const selfRollCooldowns = new Map<string, number>();
const otherRollCooldowns = new Map<string, number>();
const SELF_ROLL_COOLDOWN_MS = 60 * 1000; // 1 minute
const OTHER_ROLL_COOLDOWN_MS = 600 * 1000; // 10 minutes

const getCooldownKey = (playerId: number, targetPlayerId: number): string => {
  return `${playerId}:${targetPlayerId}`;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const isOnCooldown = (playerId: number, targetPlayerId: number): boolean => {
  const key = getCooldownKey(playerId, targetPlayerId);
  const isSelfRoll = playerId === targetPlayerId;
  const cooldownMap = isSelfRoll ? selfRollCooldowns : otherRollCooldowns;
  const cooldownTime = isSelfRoll ? SELF_ROLL_COOLDOWN_MS : OTHER_ROLL_COOLDOWN_MS;

  const timestamp = cooldownMap.get(key);
  if (!timestamp) return false;

  const now = Date.now();
  if (now - timestamp >= cooldownTime) {
    cooldownMap.delete(key);
    return false;
  }

  return true;
};

const addCooldown = (playerId: number, targetPlayerId: number): void => {
  const key = getCooldownKey(playerId, targetPlayerId);
  const isSelfRoll = playerId === targetPlayerId;
  const cooldownMap = isSelfRoll ? selfRollCooldowns : otherRollCooldowns;

  cooldownMap.set(key, Date.now());
};

const getRemainingCooldown = (playerId: number, targetPlayerId: number): number => {
  const key = getCooldownKey(playerId, targetPlayerId);
  const isSelfRoll = playerId === targetPlayerId;
  const cooldownMap = isSelfRoll ? selfRollCooldowns : otherRollCooldowns;
  const cooldownTime = isSelfRoll ? SELF_ROLL_COOLDOWN_MS : OTHER_ROLL_COOLDOWN_MS;

  const timestamp = cooldownMap.get(key);
  if (!timestamp) return 0;

  const now = Date.now();
  const remaining = cooldownTime - (now - timestamp);

  if (remaining <= 0) {
    cooldownMap.delete(key);
    return 0;
  }

  return Math.ceil(remaining / 1000); // Convert to seconds
};

router.get('/', async (req: Request, res: Response) => {
  try {
    const players = await playerStatsService.getLeaderboard();
    return res.json(players);
  } catch (error) {
    logger.error('Error fetching players:', error);
    return res.status(500).json({
      error: 'Failed to fetch players',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get('/:id([0-9]{1,20})', async (req: Request, res: Response) => {
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
            'permissionFlags',
          ],
        },
      ],
    });

    if (!playerExists) {
      return res.status(404).json({error: 'Player not found'});
    }
    // Wait for both enriched data and stats in parallel
    const [enrichedPlayer, playerStats] = await Promise.all([
      playerStatsService.getEnrichedPlayer(parseInt(id)),
      playerStatsService.getPlayerStats(parseInt(id)).then(stats => stats?.[0]),
    ]);

    // Filter out sensitive information from hidden levels and ensure no circular references
    if (enrichedPlayer?.passes) {
      enrichedPlayer.passes = enrichedPlayer.passes.map((pass: any) => {
        // Handle both Sequelize model instances and plain objects
        const plainPass = pass.get ? pass.get({plain: true}) : pass;
        if (plainPass.level && plainPass.level.isHidden) {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { level, ...passWithoutLevel } = plainPass;
          return {
            level: {
              isHidden: true
            },
            ...passWithoutLevel
          };
        }
        return plainPass;
      });
    }

    // Convert enriched player to plain object and remove any circular references
    const plainEnrichedPlayer = enrichedPlayer ? {
      ...enrichedPlayer,
      passes: enrichedPlayer.passes,
      topScores: enrichedPlayer.topScores?.map((score: any) =>
        score.get ? score.get({plain: true}) : score
      ),
      potentialTopScores: enrichedPlayer.potentialTopScores?.map((score: any) =>
        score.get ? score.get({plain: true}) : score
      )
    } : null;

    return res.json({
      ...plainEnrichedPlayer,
      stats: playerStats,
      topScores: plainEnrichedPlayer?.topScores,
      potentialTopScores: plainEnrichedPlayer?.potentialTopScores,
    });
  } catch (error) {
    logger.error('Error fetching player:', error);
    return res.status(500).json({
      error: 'Failed to fetch player',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get('/search/:name', async (req: Request, res: Response) => {
  try {
    const name = req.params.name; // Exp  ress has already decoded this
    const escapedName = escapeForMySQL(name);

    const players = await Player.findAll({
      where: {
        name: {
          [Op.like]: `%${escapedName}%`,
        },
        isBanned: false
      },
      include: [
        {
          model: User,
          as: 'user',
          required: false,
        },
      ],
    });

    const users = await User.findAll({
      where: {
        username: {
          [Op.like]: `%${escapedName}%`,
        },
      },
      include: [
        {
          model: Player,
          as: 'player',
          required: true,
          where: {
            isBanned: false
          }
        },
      ],
    });



    const allPlayers = new Set([...players, ...users.map(user => user.player)]);

    const stats = await playerStatsService.getPlayerStats(Array.from(allPlayers).map(player => player?.id || 0));

    return res.json(stats);
  } catch (error) {
    logger.error('Error searching players:', error);
    return res.status(500).json({
      error: 'Failed to search players',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});
/*
DISCORD SHOULD ONLY BE MANAGED BY USERS
router.put('/:userId/discord', Auth.superAdmin(), async (req: Request, res: Response) => {
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
        await safeTransactionRollback(transaction);
        return res.status(404).json({error: 'Player not found'});
      }

      // If another user already has this Discord ID, prevent the update
      if (
        existingUserWithDiscord &&
        (!player.user || existingUserWithDiscord.id !== player.user.id)
      ) {
        await safeTransactionRollback(transaction);
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

        // Remove any duplicate for this provider/providerId/userId
        await OAuthProvider.destroy({
          where: {
            provider: providerData.provider,
            providerId: providerData.providerId,
            userId: player.user.id,
          },
          transaction,
        });

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

      sseManager.broadcast({type: 'playerUpdate'});

      return res.json({message: 'Discord info updated successfully'});
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error updating player discord info:', error);
      return res.status(500).json({
        error: 'Failed to update player discord info',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.delete('/:id([0-9]+)/discord', Auth.superAdmin(), async (req: Request, res: Response) => {
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
      logger.error('Error removing player discord info:', error);
      return res.status(500).json({
        error: 'Failed to remove player discord info',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
*/

router.post('/create', Auth.superAdmin(), async (req: Request, res: Response) => {
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
        isBanned: false, // Keep for backward compatibility
        isSubmissionsPaused: false, // Keep for backward compatibility
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const io = getIO();
      io.emit('leaderboardUpdated');

      const enrichedPlayer = await playerStatsService.getEnrichedPlayer(player.id);
      return res.status(201).json(enrichedPlayer);
    } catch (error) {
      logger.error('Error creating player:', error);
      return res.status(500).json({
        error: 'Failed to create player',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

/*
DISCORD SHOULD ONLY BE MANAGED BY USERS
router.get('/:id([0-9]+)/discord/:discordId', Auth.superAdmin(), async (req: Request, res: Response) => {
    try {
      const {discordId} = req.params;

      // Use the utility function instead of direct API call
      const discordUser = await fetchDiscordUserInfo(discordId);

      return res.json({
        message: 'Discord info fetched successfully',
        discordUser: {
          id: discordId,
          username: discordUser.username,
          avatar: discordUser.avatar,
          avatarUrl: discordUser.avatar ?
            `https://cdn.discordapp.com/avatars/${discordId}/${discordUser.avatar}.png` :
            null
        },
      });
    } catch (error: any) {
      // Don't expose internal errors that might contain sensitive info
      logger.error('Error fetching Discord user:', error);
      return res.status(error?.status || 500).json({
        error: 'Failed to fetch Discord user',
        details: error?.status === 404 ? 'Discord user not found' : 'Error fetching Discord user information'
      });
    }
  },
);
*/

/*
DISCORD SHOULD ONLY BE MANAGED BY USERS
router.put('/:id([0-9]+)/discord/:discordId', Auth.superAdmin(), async (req: Request, res: Response) => {
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
        await safeTransactionRollback(transaction);
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

        // Remove any duplicate for this provider/providerId/userId
        await OAuthProvider.destroy({
          where: {
            provider: providerData.provider,
            providerId: providerData.providerId,
            userId: player.user.id,
          },
          transaction,
        });

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

      sseManager.broadcast({type: 'playerUpdate'});

      return res.json({
        message: 'Discord info updated successfully',
        discordInfo: profile,
      });
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error updating Discord info:', error);
      return res.status(500).json({
        error: 'Failed to update Discord info',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
*/

router.put('/:id([0-9]{1,20})/name', Auth.superAdmin(), async (req: Request, res: Response) => {
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
      logger.error('Error updating player name:', error);
      return res.status(500).json({
        error: 'Failed to update player name',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.put('/:id([0-9]{1,20})/country', Auth.superAdmin(), async (req: Request, res: Response) => {
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
      logger.error('Error updating player country:', error);
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
router.patch('/:id([0-9]{1,20})/ban', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      const {id} = req.params;
      const {isBanned} = req.body;

      const player = await Player.findByPk(id, {transaction, 
        include: [
          {
            model: User,
            as: 'user',
            attributes: ['id', 'playerId', 'nickname', 'avatarUrl', 'username', 'permissionFlags'],
          }
        ]
      });
      if (!player) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({error: 'Player not found'});
      }

      await player.update({isBanned}, {transaction});
      if (player.user) {
        await setUserPermissionAndSave(player.user, permissionFlags.BANNED, isBanned, transaction);
      }
      // Update world's first status for all affected levels
      await updateAffectedLevelsWorldsFirst(player.id, transaction);

      await transaction.commit();

      sseManager.broadcast({type: 'playerUpdate'});

      return res.json({
        message: `Player ${isBanned ? 'banned' : 'unbanned'} successfully`,
        player: {
          ...serializePlayer(player),
          isBanned: hasFlag(player.user, permissionFlags.BANNED) || player.isBanned
        },
      });
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error updating player ban status:', error);
      return res
        .status(500)
        .json({error: 'Failed to update player ban status'});
    }
  },
);

// Add this new endpoint after the ban endpoint
router.patch('/:id([0-9]{1,20})/pause-submissions', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      const {id} = req.params;
      const {isSubmissionsPaused} = req.body;

      const player = await Player.findByPk(id, {transaction, include: [{model: User, as: 'user'}]});
      if (!player) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({error: 'Player not found'});
      }

      await player.update({isSubmissionsPaused}, {transaction});

      // Update user permission flags if player has a user
      if (player.user) {
        await setUserPermissionAndSave(player.user, permissionFlags.SUBMISSIONS_PAUSED, isSubmissionsPaused, transaction);
      }

      await transaction.commit();

      sseManager.broadcast({type: 'playerUpdate'});

      return res.json({
        message: `Player submissions ${isSubmissionsPaused ? 'paused' : 'resumed'} successfully`,
        player: serializePlayer(player),
      });
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error updating player submission pause status:', error);
      return res
        .status(500)
        .json({error: 'Failed to update player submission pause status'});
    }
  },
);

router.post('/:id([0-9]{1,20})/merge', Auth.superAdmin(), async (req: Request, res: Response) => {
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
                as: 'providers',
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
                as: 'providers',
              },
            ],
          },
        ],
        transaction,
      });

      if (!sourcePlayer || !targetPlayer) {
        await safeTransactionRollback(transaction);
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

      // Update all pass submissions that reference the source player via passerId
      await PassSubmission.update(
        {passerId: targetPlayer.id},
        {
          where: {passerId: sourcePlayer.id},
          transaction,
        },
      );

      // Update all pass submissions that reference the source player via assignedPlayerId
      await PassSubmission.update(
        {assignedPlayerId: targetPlayer.id},
        {
          where: {assignedPlayerId: sourcePlayer.id},
          transaction,
        },
      );

      // Update all player modifiers that reference the source player
      await PlayerModifier.update(
        {playerId: targetPlayer.id},
        {
          where: {playerId: sourcePlayer.id},
          transaction,
        },
      );

      // If source player has a user, update OAuth providers and reassign user to target player
      if (sourcePlayer.user) {
        const sourceUserId = sourcePlayer.user.id;
        const targetUserId = targetPlayer.user?.id;
        // If target has a user, move OAuth providers and delete source user
        if (targetUserId) {
          // 1. OAuthProvider
          const sourceProviders = await OAuthProvider.findAll({
            where: { userId: sourceUserId },
            transaction,
          });
          for (const provider of sourceProviders) {
            await OAuthProvider.destroy({
              where: {
                userId: targetUserId,
                provider: provider.provider,
                providerId: provider.providerId,
              },
              transaction,
            });
            await provider.update({ userId: targetUserId }, { transaction });
          }
          // 2. RatingDetail
          await RatingDetail.update(
            {userId: targetUserId},
            {where: {userId: sourceUserId}, transaction}
          );
          // 3. RatingAccuracyVote (userId is INTEGER, so skip if not compatible)
          // Only update if both user IDs are integers
          if (sourceUserId && targetUserId) {
            await RatingAccuracyVote.update(
              {userId: targetUserId},
              {where: {userId: sourceUserId}, transaction}
            );
          }
          // 4. LevelRerateHistory
          await LevelRerateHistory.update(
            {reratedBy: targetUserId},
            {where: {reratedBy: sourceUserId}, transaction}
          );
          // 5. UsernameChange
          await UsernameChange.update(
            {userId: targetUserId},
            {where: {userId: sourceUserId}, transaction}
          );
          // 6. AuditLog
          await AuditLog.update(
            {userId: targetUserId},
            {where: {userId: sourceUserId}, transaction}
          );
          // 7. Creator (only if target user is not already linked)
          const sourceCreator = await Creator.findOne({where: {userId: sourceUserId}, transaction});
          const targetCreator = await Creator.findOne({where: {userId: targetUserId}, transaction});
          if (sourceCreator && !targetCreator) {
            await sourceCreator.update({userId: targetUserId}, {transaction});
          }
          // 8. LevelSubmission
          await LevelSubmission.update(
            {userId: targetUserId},
            {where: {userId: sourceUserId}, transaction}
          );
          // 9. PassSubmission
          await PassSubmission.update(
            {userId: targetUserId},
            {where: {userId: sourceUserId}, transaction}
          );
          // Now delete the source user
          await User.destroy({
            where: {id: sourceUserId},
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
        where: {id: sourcePlayer.id},
        transaction,
      });

      // Delete the source player
      await Player.destroy({
        where: {id: sourcePlayer.id},
        transaction,
      });

      await transaction.commit();

      // Update stats for target player
      await playerStatsService.updatePlayerStats([targetPlayer.id]);

      const io = getIO();
      io.emit('leaderboardUpdated');

      return res.json({message: 'Players merged successfully'});
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error merging players:', error);
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
      isBanned: false, // Keep for backward compatibility
      isSubmissionsPaused: false, // Keep for backward compatibility
      createdAt: new Date(),
      updatedAt: new Date()
    });

    return res.status(201).json({
      id: player.id,
      name: player.name
    });
  } catch (error) {
    logger.error('Error creating player profile:', error);
    return res.status(500).json({ error: 'Failed to create player profile' });
  }
});

router.get('/:playerId([0-9]{1,20})/modifiers', Auth.addUserToRequest(), async (req, res) => {
  try {
    if (!modifierService) {
      return res.status(727).json({ error: 'April fools over, modifiers are disabled' });
    }
    // if (req.user?.player?.isBanned) {
    //   return res.status(403).json({ error: 'Oops! Banned' });
    // }

    const playerId = req.user?.playerId;
    const targetPlayerId = parseInt(req.params.playerId);


    const modifiers = await modifierService.getActiveModifiers(targetPlayerId);

    // Get cooldown information
    let remainingCooldown = 0;
    if (playerId) {
      remainingCooldown = getRemainingCooldown(playerId, targetPlayerId);
    }

    return res.json({
      modifiers,
      probabilities: PlayerModifier.PROBABILITIES,
      cooldown: {
        remainingSeconds: remainingCooldown,
        isSelfRoll: playerId === targetPlayerId
      }
    });
  } catch (error) {
    logger.error('Error fetching modifiers:', error);
    return res.status(500).json({ error: 'Failed to fetch modifiers' });
  }
});

// Generate a new random modifier for the player
router.post('/modifiers/generate', Auth.verified(), async (req, res) => {
  if (!modifierService) {
    return res.status(727).json({ error: 'April fools over, modifiers are disabled' });
  }
  try {
    const playerId = req.user?.playerId;
    const targetPlayerId = parseInt(req.body.targetPlayerId);

    if (!playerId) {
      return res.status(403).json({ error: 'Player ID not found' });
    }

    if (!targetPlayerId) {
      return res.status(400).json({ error: 'Target player ID is required' });
    }

    // Check cooldown first
    const remainingCooldown = getRemainingCooldown(playerId, targetPlayerId);

    if (remainingCooldown > 0) {
      return res.status(429).json({
        error: 'Spin cooldown active',
        remainingSeconds: remainingCooldown,
        isSelfRoll: playerId === targetPlayerId
      });
    }

    const result = await modifierService.handleModifierGeneration(playerId, targetPlayerId);

    if (result.error || !result.modifier) {
      return res.status(400).json({ error: result.error });
    }

    // Apply the modifier
    await modifierService.applyModifier(result.modifier);

    // Add cooldown after successful generation
    addCooldown(playerId, targetPlayerId);

    return res.json({ modifier: result.modifier });
  } catch (error) {
    logger.error('Error generating modifier:', error);
    return res.status(500).json({ error: 'Failed to generate modifier' });
  }
});

export default router;
