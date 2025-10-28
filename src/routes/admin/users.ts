import {Router, Request, Response, NextFunction} from 'express';
import {Auth} from '../../middleware/auth.js';
import {User, OAuthProvider} from '../../models/index.js';
import Player from '../../models/players/Player.js';
import {fetchDiscordUserInfo} from '../../utils/auth/discord.js';
import {Op} from 'sequelize';
import {tokenUtils} from '../../utils/auth/auth.js';
import { logger } from '../../services/LoggerService.js';
import { hasFlag, setUserPermissionAndSave, wherehasFlag } from '../../utils/auth/permissionUtils.js';
import { permissionFlags } from '../../config/constants.js';

const router: Router = Router();

// Helper function to check if operation requires password
const requireGrantRole = (req: Request, res: Response, next: NextFunction) => {
  const {role} = req.body as {role: string};

  if (role === 'curator') {
    return Auth.headCurator()(req, res, next);
  }
  if (role === 'headcurator' || role === 'rater') {
    return Auth.superAdmin()(req, res, next);
  }
  if (role === 'superadmin') {
    return Auth.superAdminPassword()(req, res, next);
  }
  return next();
};

router.get('/raters', async (req: Request, res: Response) => {
  try {
    const raters = await User.findAll({
      where: {
        [Op.or]: [
          {permissionFlags: wherehasFlag(permissionFlags.RATER)},
          {permissionFlags: wherehasFlag(permissionFlags.SUPER_ADMIN)},
        ],
      },
      include: [
        {
          model: Player,
          as: 'player',
          required: false,
        },
      ],
    });

    return res.json(
      raters.map(user => {
        return {
          id: user.id,
          username: user.username,
          nickname: user.nickname,
          avatarUrl: user.avatarUrl,
          isRater: hasFlag(user, permissionFlags.RATER),
          isSuperAdmin: hasFlag(user, permissionFlags.SUPER_ADMIN),
          permissionFlags: user.permissionFlags.toString(), // Convert BigInt to string
          playerId: user.playerId,
          player: user.player,
        };
      }),
    );
  } catch (error) {
    logger.error('Failed to fetch raters:', error);
    return res.status(500).json({error: 'Failed to fetch raters'});
  }
});

// Get all users with roles (raters and admins)
router.get('/', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const users = await User.findAll({
      where: {
        [Op.or]: [
          {permissionFlags: wherehasFlag(permissionFlags.RATER)},
          {permissionFlags: wherehasFlag(permissionFlags.SUPER_ADMIN)},
        ],
      },
      include: [
        {
          model: Player,
          as: 'player',
          required: false,
        },
      ],
    });

          return res.json(
        users.map(user => {
          return {
            id: user.id,
            username: user.username,
            nickname: user.nickname,
            avatarUrl: user.avatarUrl,
            isRater: hasFlag(user, permissionFlags.RATER),
            isSuperAdmin: hasFlag(user, permissionFlags.SUPER_ADMIN),
            permissionFlags: user.permissionFlags.toString(), // Convert BigInt to string
            playerId: user.playerId,
            player: user.player
          };
        }),
      );
  } catch (error) {
    logger.error('Failed to fetch users:', error);
    return res.status(500).json({error: 'Failed to fetch users'});
  }
});

// Get all curators
router.get('/curators', async (req: Request, res: Response) => {
  try {
    const curators = await User.findAll({
      where: {
        [Op.or]: [
          {permissionFlags: wherehasFlag(permissionFlags.CURATOR)},
          {permissionFlags: wherehasFlag(permissionFlags.HEAD_CURATOR)},
        ],
      },
      include: [
        {
          model: Player,
          as: 'player',
          required: false,
        },
      ],
    });

    return res.json(
      curators.map(user => {
        return {
          id: user.id,
          username: user.username,
          nickname: user.nickname,
          avatarUrl: user.avatarUrl,
          isCurator: hasFlag(user, permissionFlags.CURATOR),
          isHeadCurator: hasFlag(user, permissionFlags.HEAD_CURATOR),
          permissionFlags: user.permissionFlags.toString(), // Convert BigInt to string
          playerId: user.playerId,
          player: user.player
        };
      }),
    );
  } catch (error) {
    logger.error('Failed to fetch curators:', error);
    return res.status(500).json({error: 'Failed to fetch curators'});
  }
});

// Grant role to user
router.post(
  '/grant-role',
  [Auth.headCurator(), requireGrantRole],
  async (req: Request, res: Response) => {
    try {
      const {username, role} = req.body;

      if (!username) {
        return res.status(400).json({
          error: 'Username and a valid role (rater/superadmin/curator/headcurator) are required',
        });
      }
      if (!['rater', 'superadmin', 'curator', 'headcurator'].includes(role)) {
        return res.status(400).json({
          error: 'Valid role (rater/superadmin/curator/headcurator) is required',
        });
      }

      const userToUpdate = await User.findOne({ where: { username } });
      if (!userToUpdate) {
        return res.status(404).json({error: 'User not found'});
      }

      // Map role names to permission flags
      const roleToFlag: Record<string, bigint> = {
        'rater': permissionFlags.RATER,
        'superadmin': permissionFlags.SUPER_ADMIN,
        'curator': permissionFlags.CURATOR,
        'headcurator': permissionFlags.HEAD_CURATOR
      };

      const targetFlag = roleToFlag[role];

      // For ascending roles, we need to handle the hierarchy
      if (role === 'headcurator') {
        // Grant both curator and head curator
        await setUserPermissionAndSave(userToUpdate, permissionFlags.CURATOR, true);
        await setUserPermissionAndSave(userToUpdate, permissionFlags.HEAD_CURATOR, true);
      } else if (role === 'superadmin') {
        // Grant both rater and super admin
        await setUserPermissionAndSave(userToUpdate, permissionFlags.RATER, true);
        await setUserPermissionAndSave(userToUpdate, permissionFlags.SUPER_ADMIN, true);
      } else {
        // Grant the specific role
        await setUserPermissionAndSave(userToUpdate, targetFlag, true);
      }

      return res.json({
        message: 'Role granted successfully',
        user: {
          id: userToUpdate.id,
          username: userToUpdate.username,
          isRater: hasFlag(userToUpdate, permissionFlags.RATER),
          isSuperAdmin: hasFlag(userToUpdate, permissionFlags.SUPER_ADMIN),
          isCurator: hasFlag(userToUpdate, permissionFlags.CURATOR),
          isHeadCurator: hasFlag(userToUpdate, permissionFlags.HEAD_CURATOR),
          permissionFlags: userToUpdate.permissionFlags.toString(), // Convert BigInt to string
          playerId: userToUpdate.playerId,
        },
      });
    } catch (error: any) {
      logger.error('Failed to grant role:', error);
      logger.error('Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
      return res.status(500).json({error: 'Failed to grant role'});
    }
  },
);

// Revoke role from user
router.post(
  '/revoke-role',
  [Auth.superAdmin(), requireGrantRole],
  async (req: Request, res: Response) => {
    try {
      const {userId, username, role} = req.body;

      if (!userId && !username) {
        return res.status(400).json({
          error: 'User ID or username and a valid role (rater/superadmin/curator/headcurator) are required',
        });
      }
      if (!['rater', 'superadmin', 'curator', 'headcurator'].includes(role)) {
        return res.status(400).json({
          error: 'Valid role (rater/superadmin/curator/headcurator) is required',
        });
      }

      let userToUpdate = null;
      if (userId) {
        userToUpdate = await User.findByPk(userId);
      } else if (username) {
        userToUpdate = await User.findOne({ where: { username } });
      }
      if (!userToUpdate) {
        return res.status(404).json({error: 'User not found'});
      }

      // Prevent revoking last super admin
      if (role === 'superadmin') {
        const superAdminCount = await User.count({where: {permissionFlags: wherehasFlag(permissionFlags.SUPER_ADMIN)}});
        if (superAdminCount <= 1 && hasFlag(userToUpdate, permissionFlags.SUPER_ADMIN)) {
          return res
            .status(400)
            .json({error: 'Cannot remove last super admin'});
        }
      }

      // For ascending roles, we need to handle the hierarchy
      if (role === 'headcurator') {
        // Remove head curator but keep curator
        await setUserPermissionAndSave(userToUpdate, permissionFlags.HEAD_CURATOR, false);
      } else if (role === 'superadmin') {
        // Remove super admin but keep rater
        await setUserPermissionAndSave(userToUpdate, permissionFlags.SUPER_ADMIN, false);
      } else {
        // Remove the specific role and any higher roles in the hierarchy
      if (role === 'rater') {
          // Remove both rater and super admin
        await setUserPermissionAndSave(userToUpdate, permissionFlags.RATER, false);
        await setUserPermissionAndSave(userToUpdate, permissionFlags.SUPER_ADMIN, false);
      } else if (role === 'curator') {
        // Remove both curator and head curator
        await setUserPermissionAndSave(userToUpdate, permissionFlags.CURATOR, false);
        await setUserPermissionAndSave(userToUpdate, permissionFlags.HEAD_CURATOR, false);
      }
      }

      // Generate new token with updated permissions
      const newToken = tokenUtils.generateJWT(userToUpdate);

      return res.json({
        message: 'Role revoked successfully',
        user: {
          id: userToUpdate.id,
          username: userToUpdate.username,
          isRater: hasFlag(userToUpdate, permissionFlags.RATER),
          isSuperAdmin: hasFlag(userToUpdate, permissionFlags.SUPER_ADMIN),
          isCurator: hasFlag(userToUpdate, permissionFlags.CURATOR),
          isHeadCurator: hasFlag(userToUpdate, permissionFlags.HEAD_CURATOR),
          permissionFlags: userToUpdate.permissionFlags.toString(), // Convert BigInt to string
        },
        token: newToken,
      });
    } catch (error: any) {
      logger.error('Failed to revoke role:', error);
      logger.error('Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
      return res.status(500).json({error: 'Failed to revoke role'});
    }
  },
);

// Update user's Discord info
router.post(
  '/sync-discord',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const users = await User.findAll({
        include: [
          {
            model: OAuthProvider,
            as: 'providers',
            where: {provider: 'discord'},
            required: true,
          },
        ],
      });

      const updates = [];
      const errors = [];

      for (const user of users) {
        const discordId = user.providers![0].providerId;

        try {
          const discordInfo = await fetchDiscordUserInfo(discordId);

          if (discordInfo.username && discordInfo.username !== user.username) {
            await user.update({username: discordInfo.username});
            updates.push(discordId);
          }
        } catch (error) {
          logger.error(
            `Failed to fetch Discord info for ${discordId}:`,
            error,
          );
          errors.push(discordId);
        }
      }

      return res.json({
        message: 'Discord info sync completed',
        updatedCount: updates.length,
        failedIds: errors,
      });
    } catch (error: any) {
      logger.error('Failed to sync Discord info:', error);
      logger.error('Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
      return res.status(500).json({error: 'Failed to sync Discord info'});
    }
  },
);

// Toggle rating ban for user
router.patch(
  '/:playerId/rating-ban',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const {playerId} = req.params;
      const {isRatingBanned} = req.body;

      if (typeof isRatingBanned !== 'boolean') {
        return res.status(400).json({error: 'isRatingBanned must be a boolean'});
      }

      // Find player and their associated user
      const player = await Player.findByPk(playerId, {
        include: [{
          model: User,
          as: 'user',
          required: true
        }]
      });

      if (!player || !player.user) {
        return res.status(404).json({error: 'Player or associated user not found'});
      }

      // Update the user's rating ban status
      await player.user.update({isRatingBanned});

      return res.json({
        message: 'Rating ban status updated successfully',
        user: {
          id: player.user.id,
          username: player.user.username,
          isRatingBanned: hasFlag(player.user, permissionFlags.RATING_BANNED),
        },
      });
    } catch (error: any) {
      logger.error('Failed to update rating ban status:', error);
      logger.error('Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
      return res.status(500).json({error: 'Failed to update rating ban status'});
    }
  },
);

// Check user roles
router.get('/check/:discordId', async (req: Request, res: Response) => {
  try {
    const {discordId} = req.params;

    // Find user through OAuth provider
    const provider = await OAuthProvider.findOne({
      where: {
        provider: 'discord',
        providerId: discordId,
      },
      include: [
        {
          model: User,
          as: 'oauthUser',
          required: true,
        },
      ],
    });

    if (!provider?.oauthUser) {
      return res.json({isRater: false, isSuperAdmin: false});
    }

    return res.json({
      isRater: hasFlag(provider.oauthUser, permissionFlags.RATER),
      isSuperAdmin: hasFlag(provider.oauthUser, permissionFlags.SUPER_ADMIN),
      permissionFlags: provider.oauthUser.permissionFlags.toString(), // Convert BigInt to string
    });
  } catch (error: any) {
    logger.error('Failed to check roles:', error);
    logger.error('Error details:', {
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({error: 'Failed to check roles'});
  }
});

// Get user by Discord ID
router.get(
  '/discord/:discordId',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const {discordId} = req.params;

      // Find user through OAuth provider
      const provider = await OAuthProvider.findOne({
        where: {
          provider: 'discord',
          providerId: discordId,
        },
        include: [
          {
            model: User,
            as: 'oauthUser',
            required: true,
          },
        ],
      });

      if (!provider?.oauthUser) {
        return res.status(404).json({error: 'User not found'});
      }

      return res.json({
        id: provider.oauthUser.id,
        username: provider.oauthUser.username,
        avatarUrl: provider.oauthUser.avatarUrl,
        permissionFlags: provider.oauthUser.permissionFlags.toString(), // Convert BigInt to string
      });
    } catch (error: any) {
      logger.error('Error fetching user by Discord ID:', error);
      logger.error('Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
      return res.status(500).json({error: 'Failed to fetch user'});
    }
  },
);

export default router;
