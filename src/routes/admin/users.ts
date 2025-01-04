import { Router, Request, Response, NextFunction } from 'express';
import { Auth } from '../../middleware/auth';
import { User, OAuthProvider } from '../../models';
import Player from '../../models/Player';
import { fetchDiscordUserInfo } from '../../utils/discord';
import { CreationAttributes, Op } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';

const router: Router = Router();

interface OAuthProviderWithUser extends OAuthProvider {
  User?: User;
}

// Helper function to find or create user by Discord ID
async function findOrCreateUserByDiscordId(discordId: string, discordInfo: any) {
  // First try to find existing OAuth provider
  const provider = await OAuthProvider.findOne({
    where: {
      provider: 'discord',
      providerId: discordId
    },
    include: [{
      model: User,
      required: false,
      include: [{
        model: OAuthProvider,
        as: 'providers',
        where: { provider: 'discord' },
        required: false
      }]
    }]
  }) as OAuthProviderWithUser | null;

  // If provider exists but no user is associated, something is wrong
  if (provider && !provider.User) {
    throw new Error('OAuth provider exists but no user is associated');
  }

  // If we found the user, return it
  if (provider?.User) {
    return provider.User;
  }

  // If no user exists, create a player first
  const now = new Date();
  const player = await Player.create({
    name: discordInfo.username,
    country: 'XX', // Default country code
    isBanned: false,
    discordId,
    discordUsername: discordInfo.username,
    discordAvatarId: discordInfo.avatar,
    discordAvatar: discordInfo.avatar ? 
      `https://cdn.discordapp.com/avatars/${discordId}/${discordInfo.avatar}.png` : 
      null,
    createdAt: now,
    updatedAt: now
  });

  // Then create the user
  const user = await User.create({
    id: uuidv4(),
    username: discordInfo.username,
    isEmailVerified: false,
    isRater: false,
    isSuperAdmin: false,
    status: 'active',
    playerId: player.id,
    createdAt: now,
    updatedAt: now
  });

  // Create OAuth provider
  await OAuthProvider.create({
    userId: user.id,
    provider: 'discord',
    providerId: discordId,
    profile: discordInfo,
    accessToken: '',
    tokenExpiry: now,
    createdAt: now,
    updatedAt: now
  } as CreationAttributes<OAuthProvider>);

  // Fetch the user again with providers included
  const createdUser = await User.findByPk(user.id, {
    include: [{
      model: OAuthProvider,
      as: 'providers',
      where: { provider: 'discord' },
      required: true
    }]
  });

  if (!createdUser) {
    throw new Error('Failed to create user');
  }

  return createdUser;
}

// Helper function to check if operation requires password
const requiresPassword = (req: Request, res: Response, next: NextFunction) => {
  const { role } = req.body;
  if (role === 'superadmin') {
    return Auth.superAdminPassword()(req, res, next);
  }
  return next();
};

router.get('/raters', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const raters = await User.findAll({
      where: {
        [Op.or]: [
          { isRater: true },
          { isSuperAdmin: true }
        ]
      },
      include: [
        {
          model: OAuthProvider,
          as: 'providers',
          where: { provider: 'discord' },
          required: true
        },
        {
          model: Player,
          as: 'player',
          required: false
        }
      ]
    });

    return res.json(raters.map(user => {
      const discordProvider = user.providers![0];
      const discordProfile = discordProvider.profile as { 
        username?: string; 
        avatar?: string;
        id?: string;
      } || {};
      
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
        discordAvatar: discordProfile.avatar ? 
          `https://cdn.discordapp.com/avatars/${discordProvider.providerId}/${discordProfile.avatar}.png` : 
          null
      };
    }));
  } catch (error) {
    console.error('Failed to fetch raters:', error);
    return res.status(500).json({ error: 'Failed to fetch raters' });
  }
});


// Get all users with roles (raters and admins)
router.get('/', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const users = await User.findAll({
      where: {
        [Op.or]: [
          { isRater: true },
          { isSuperAdmin: true }
        ]
      },
      include: [
        {
          model: OAuthProvider,
          as: 'providers',
          where: { provider: 'discord' },
          required: true
        },
        {
          model: Player,
          as: 'player',
          required: false
        }
      ]
    });

    return res.json(users.map(user => {
      const discordProvider = user.providers![0];
      const discordProfile = discordProvider.profile as { 
        username?: string; 
        avatar?: string;
      } || {};
      
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
        discordAvatar: discordProfile.avatar ? 
          `https://cdn.discordapp.com/avatars/${discordProvider.providerId}/${discordProfile.avatar}.png` : 
          null
      };
    }));
  } catch (error) {
    console.error('Failed to fetch users:', error);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Grant rater role to user
router.post('/grant-role', [Auth.superAdmin(), requiresPassword], async (req: Request, res: Response) => {
  try {
    const { discordId, role } = req.body;
    
    if (!discordId || !['rater', 'superadmin'].includes(role)) {
      return res.status(400).json({ error: 'Discord ID and valid role (rater/superadmin) are required' });
    }

    // Fetch Discord info
    try {
      const discordInfo = await fetchDiscordUserInfo(discordId);
      if (!discordInfo) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Find or create user
      const user = await findOrCreateUserByDiscordId(discordId, discordInfo);
      if (!user) {
        return res.status(500).json({ error: 'Failed to find or create user' });
      }

      // Update roles
      await user.update({
        isRater: role === 'rater' ? true : user.isRater,
        isSuperAdmin: role === 'superadmin' ? true : user.isSuperAdmin
      });

      return res.json({
        message: 'Role granted successfully',
        user: {
          id: user.id,
          username: user.username,
          discordId,
          isRater: user.isRater,
          isSuperAdmin: user.isSuperAdmin,
          playerId: user.playerId
        }
      });
    } catch (error: any) {
      if (error.message?.includes('Failed to fetch Discord user info: Not Found')) {
        return res.status(404).json({ error: 'User not found' });
      }
      throw error;
    }
  } catch (error) {
    console.error('Failed to grant role:', error);
    return res.status(500).json({ error: 'Failed to grant role' });
  }
});

// Revoke role from user
router.post('/revoke-role', [Auth.superAdmin(), requiresPassword], async (req: Request, res: Response) => {
  try {
    const { discordId, role } = req.body;
    
    if (!discordId || !['rater', 'superadmin'].includes(role)) {
      return res.status(400).json({ error: 'Discord ID and valid role (rater/superadmin) are required' });
    }

    const provider = await OAuthProvider.findOne({
      where: {
        provider: 'discord',
        providerId: discordId
      },
      include: [{
        model: User,
        required: true,
        include: [{
          model: OAuthProvider,
          as: 'providers',
          where: { provider: 'discord' },
          required: false
        }]
      }]
    }) as OAuthProviderWithUser | null;

    if (!provider?.User) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent revoking last super admin
    if (role === 'superadmin') {
      const superAdminCount = await User.count({ where: { isSuperAdmin: true } });
      if (superAdminCount <= 1 && provider.User.isSuperAdmin) {
        return res.status(400).json({ error: 'Cannot remove last super admin' });
      }
    }

    // Update user's roles
    await provider.User.update({
      isRater: role === 'rater' ? false : provider.User.isRater,
      isSuperAdmin: role === 'superadmin' ? false : provider.User.isSuperAdmin
    });

    return res.json({
      message: 'Role revoked successfully',
      user: {
        id: provider.User.id,
        username: provider.User.username,
        discordId,
        isRater: provider.User.isRater,
        isSuperAdmin: provider.User.isSuperAdmin
      }
    });
  } catch (error) {
    console.error('Failed to revoke role:', error);
    return res.status(500).json({ error: 'Failed to revoke role' });
  }
});

// Update user's Discord info
router.post('/sync-discord', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const users = await User.findAll({
      include: [{
        model: OAuthProvider,
        as: 'providers',
        where: { provider: 'discord' },
        required: true
      }]
    });

    const updates = [];
    const errors = [];

    for (const user of users) {
      const discordId = user.providers![0].providerId;
      try {
        const discordInfo = await fetchDiscordUserInfo(discordId);
        if (discordInfo.username && discordInfo.username !== user.username) {
          await user.update({ username: discordInfo.username });
          updates.push(discordId);
        }
      } catch (error) {
        console.error(`Failed to fetch Discord info for ${discordId}:`, error);
        errors.push(discordId);
      }
    }

    return res.json({
      message: 'Discord info sync completed',
      updatedCount: updates.length,
      failedIds: errors
    });
  } catch (error) {
    console.error('Failed to sync Discord info:', error);
    return res.status(500).json({ error: 'Failed to sync Discord info' });
  }
});

// Check user roles
router.get('/check/:discordId', async (req: Request, res: Response) => {
  try {
    const { discordId } = req.params;
    const provider = await OAuthProvider.findOne({
      where: {
        provider: 'discord',
        providerId: discordId
      },
      include: [{ model: User, as: 'user' }]
    });

    if (!provider?.user) {
      return res.json({ isRater: false, isSuperAdmin: false });
    }

    return res.json({
      isRater: provider.user.isRater,
      isSuperAdmin: provider.user.isSuperAdmin
    });
  } catch (error) {
    console.error('Failed to check roles:', error);
    return res.status(500).json({ error: 'Failed to check roles' });
  }
});

export default router; 