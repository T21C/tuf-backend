import {Router, Request, Response, NextFunction} from 'express';
import {Auth} from '../../middleware/auth.js';
import {User, OAuthProvider} from '../../models/index.js';
import Player from '../../models/players/Player.js';
import {fetchDiscordUserInfo} from '../../utils/discord.js';
import {Op} from 'sequelize';
import {tokenUtils} from '../../utils/auth.js';

const router: Router = Router();

// Helper function to check if operation requires password
const requiresPassword = (req: Request, res: Response, next: NextFunction) => {
  const {role} = req.body;
  if (role === 'superadmin') {
    return Auth.superAdminPassword()(req, res, next);
  }
  return next();
};

router.get('/raters', async (req: Request, res: Response) => {
  try {
    const raters = await User.findAll({
      where: {
        [Op.or]: [{isRater: true}, {isSuperAdmin: true}],
      },
      include: [
        {
          model: OAuthProvider,
          as: 'providers',
          where: {provider: 'discord'},
          required: true,
        },
        {
          model: Player,
          as: 'player',
          required: false,
        },
      ],
    });

    return res.json(
      raters.map(user => {
        const discordProvider = user.providers![0];
        const discordProfile =
          (discordProvider.profile as {
            username?: string;
            avatar?: string;
            id?: string;
          }) || {};

        return {
          id: user.id,
          username: user.username,
          nickname: user.nickname,
          avatarUrl: user.avatarUrl,
          isRater: user.isRater,
          isSuperAdmin: user.isSuperAdmin,
          playerId: user.playerId,
          player: user.player,
          discordId: discordProvider.providerId,
          discordUsername: discordProfile.username
        };
      }),
    );
  } catch (error) {
    console.error('Failed to fetch raters:', error);
    return res.status(500).json({error: 'Failed to fetch raters'});
  }
});

// Get all users with roles (raters and admins)
router.get('/', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const users = await User.findAll({
      where: {
        [Op.or]: [{isRater: true}, {isSuperAdmin: true}],
      },
      include: [
        {
          model: OAuthProvider,
          as: 'providers',
          where: {provider: 'discord'},
          required: true,
        },
        {
          model: Player,
          as: 'player',
          required: false,
        },
      ],
    });

    return res.json(
      users.map(user => {
        const discordProvider = user.providers![0];
        const discordProfile =
          (discordProvider.profile as {
            username?: string;
            avatar?: string;
          }) || {};

        return {
          id: user.id,
          username: user.username,
          nickname: user.nickname,
          avatarUrl: user.avatarUrl,
          isRater: user.isRater,
          isSuperAdmin: user.isSuperAdmin,
          playerId: user.playerId,
          player: user.player,
          discordId: discordProvider.providerId,
          discordUsername: discordProfile.username,
        };
      }),
    );
  } catch (error) {
    console.error('Failed to fetch users:', error);
    return res.status(500).json({error: 'Failed to fetch users'});
  }
});

// Grant rater role to user
router.post(
  '/grant-role',
  [Auth.superAdmin(), requiresPassword],
  async (req: Request, res: Response) => {
    try {
      const {discordId, role} = req.body;

      if (!discordId || !['rater', 'superadmin'].includes(role)) {
        return res.status(400).json({
          error: 'Discord ID and valid role (rater/superadmin) are required',
        });
      }

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

      // Update user's role
      await provider.oauthUser.update({
        isRater: role === 'rater' ? true : provider.oauthUser.isRater,
        isSuperAdmin:
          role === 'superadmin' ? true : provider.oauthUser.isSuperAdmin,
      });

      return res.json({
        message: 'Role granted successfully',
        user: {
          id: provider.oauthUser.id,
          username: provider.oauthUser.username,
          discordId,
          isRater: provider.oauthUser.isRater,
          isSuperAdmin: provider.oauthUser.isSuperAdmin,
          playerId: provider.oauthUser.playerId,
        },
      });
    } catch (error: any) {
      console.error('Failed to grant role:', error);
      console.error('Error details:', {
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
  [Auth.superAdmin(), requiresPassword],
  async (req: Request, res: Response) => {
    try {
      const {discordId, role} = req.body;

      if (!discordId || !['rater', 'superadmin'].includes(role)) {
        return res.status(400).json({
          error: 'Discord ID and valid role (rater/superadmin) are required',
        });
      }

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

      // Prevent revoking last super admin
      if (role === 'superadmin') {
        const superAdminCount = await User.count({where: {isSuperAdmin: true}});
        if (superAdminCount <= 1 && provider.oauthUser.isSuperAdmin) {
          return res
            .status(400)
            .json({error: 'Cannot remove last super admin'});
        }
      }

      // Update user's roles and increment permission version
      await provider.oauthUser.update({
        isRater: role === 'rater' ? false : provider.oauthUser.isRater,
        isSuperAdmin:
          role === 'superadmin' ? false : provider.oauthUser.isSuperAdmin,
        permissionVersion: provider.oauthUser.permissionVersion + 1,
      });

      // Generate new token with updated permissions
      const newToken = tokenUtils.generateJWT(provider.oauthUser);

      return res.json({
        message: 'Role revoked successfully',
        user: {
          id: provider.oauthUser.id,
          username: provider.oauthUser.username,
          discordId,
          isRater: provider.oauthUser.isRater,
          isSuperAdmin: provider.oauthUser.isSuperAdmin,
        },
        token: newToken,
      });
    } catch (error: any) {
      console.error('Failed to revoke role:', error);
      console.error('Error details:', {
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
          console.error(
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
      console.error('Failed to sync Discord info:', error);
      console.error('Error details:', {
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
          isRatingBanned: player.user.isRatingBanned,
        },
      });
    } catch (error: any) {
      console.error('Failed to update rating ban status:', error);
      console.error('Error details:', {
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
      isRater: provider.oauthUser.isRater,
      isSuperAdmin: provider.oauthUser.isSuperAdmin,
    });
  } catch (error: any) {
    console.error('Failed to check roles:', error);
    console.error('Error details:', {
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
      });
    } catch (error: any) {
      console.error('Error fetching user by Discord ID:', error);
      console.error('Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
      return res.status(500).json({error: 'Failed to fetch user'});
    }
  },
);

export default router;
