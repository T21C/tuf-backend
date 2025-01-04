import { Router, Request, Response } from 'express';
import { Auth } from '../../middleware/auth';
import { User, OAuthProvider } from '../../models';
import { fetchDiscordUserInfo } from '../../utils/discord';
import { CreationAttributes, Op } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';

const router: Router = Router();

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
      include: [{
        model: OAuthProvider,
        as: 'providers',
        where: { provider: 'discord' },
        required: true
      }]
    });

    return res.json(users.map(user => ({
      id: user.id,
      username: user.username,
      discordId: user.providers![0].providerId,
      isRater: user.isRater,
      isSuperAdmin: user.isSuperAdmin
    })));
  } catch (error) {
    console.error('Failed to fetch users:', error);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Grant rater role to user
router.post('/grant-role', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const { discordId, role } = req.body;
    
    if (!discordId || !['rater', 'superadmin'].includes(role)) {
      return res.status(400).json({ error: 'Discord ID and valid role (rater/superadmin) are required' });
    }

    // Find user by Discord provider ID
    const provider = await OAuthProvider.findOne({
      where: {
        provider: 'discord',
        providerId: discordId
      },
      include: [{ model: User, as: 'user' }]
    });

    if (!provider?.user) {
      // If user doesn't exist, fetch Discord info and create placeholder user
      try {
        const discordInfo = await fetchDiscordUserInfo(discordId);
        const now = new Date();
        
        // Create user with UUID
        const user = await User.create({
          id: uuidv4(),
          username: discordInfo.username,
          isEmailVerified: false,
          isRater: role === 'rater',
          isSuperAdmin: role === 'superadmin',
          status: 'active',
          createdAt: now,
          updatedAt: now
        });

        // Create OAuth provider with timestamps
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

        return res.status(201).json({
          message: 'User created and role granted',
          user: {
            id: user.id,
            username: user.username,
            discordId,
            isRater: user.isRater,
            isSuperAdmin: user.isSuperAdmin
          }
        });
      } catch (discordError) {
        console.error('Failed to fetch Discord info:', discordError);
        return res.status(400).json({ error: 'Failed to fetch Discord info for the provided ID' });
      }
    }

    // Update existing user's roles
    await provider.user.update({
      isRater: role === 'rater' ? true : provider.user.isRater,
      isSuperAdmin: role === 'superadmin' ? true : provider.user.isSuperAdmin
    });

    return res.json({
      message: 'Role granted successfully',
      user: {
        id: provider.user.id,
        username: provider.user.username,
        discordId,
        isRater: provider.user.isRater,
        isSuperAdmin: provider.user.isSuperAdmin
      }
    });
  } catch (error) {
    console.error('Failed to grant role:', error);
    return res.status(500).json({ error: 'Failed to grant role' });
  }
});

// Revoke role from user
router.post('/revoke-role', [Auth.superAdmin(), Auth.superAdminPassword()], async (req: Request, res: Response) => {
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
      include: [{ model: User, as: 'user' }]
    });

    if (!provider?.user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent revoking last super admin
    if (role === 'superadmin') {
      const superAdminCount = await User.count({ where: { isSuperAdmin: true } });
      if (superAdminCount <= 1 && provider.user.isSuperAdmin) {
        return res.status(400).json({ error: 'Cannot remove last super admin' });
      }
    }

    // Update user's roles
    await provider.user.update({
      isRater: role === 'rater' ? false : provider.user.isRater,
      isSuperAdmin: role === 'superadmin' ? false : provider.user.isSuperAdmin
    });

    return res.json({
      message: 'Role revoked successfully',
      user: {
        id: provider.user.id,
        username: provider.user.username,
        discordId,
        isRater: provider.user.isRater,
        isSuperAdmin: provider.user.isSuperAdmin
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