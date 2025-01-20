import { Router, Request, Response, NextFunction } from 'express';
import { Auth } from '../../middleware/auth';
import { User, OAuthProvider } from '../../models';
import Player from '../../models/Player';
import { fetchDiscordUserInfo } from '../../utils/discord';
import { CreationAttributes, Op } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';
import { tokenUtils } from '../../utils/auth';

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

  // Try to find an existing player with the same name first
  const now = new Date();
  let player = await Player.findOne({
    where: { name: discordInfo.username }
  });

  // If no player exists with this name, create a new one
  if (!player) {
    player = await Player.create({
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
  } else {
    // Update the existing player with Discord info
    await player.update({
      discordId,
      discordUsername: discordInfo.username,
      discordAvatarId: discordInfo.avatar,
      discordAvatar: discordInfo.avatar ? 
        `https://cdn.discordapp.com/avatars/${discordId}/${discordInfo.avatar}.png` : 
        null,
      updatedAt: now
    });
  }

  // Then create the user
  const user = await User.create({
    id: uuidv4(),
    username: discordInfo.username,
    isEmailVerified: false,
    isRater: false,
    isSuperAdmin: false,
    permissionVersion: 1,
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

router.get('/raters', async (req: Request, res: Response) => {
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
  } catch (error: any) {
    console.error('Failed to grant role:', error);
    console.error('Error details:', {
      name: error.name,
      message: error.message,
      stack: error.stack
    });
    return res.status(500).json({ error: 'Failed to grant role' });
  }
});

// Revoke role from user
router.post('/revoke-role', [Auth.superAdmin(), requiresPassword], async (req: Request, res: Response) => {
  try {
    const { discordId, role } = req.body;
    console.log('Revoking role:', { discordId, role });
    
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
        as: 'oauthUser'
      }]
    });
    console.log(provider?.dataValues);
    if (!provider?.oauthUser) {
      console.log('No user found for role revocation, Discord ID:', discordId);
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent revoking last super admin
    if (role === 'superadmin') {
      const superAdminCount = await User.count({ where: { isSuperAdmin: true } });
      console.log('Super admin count:', superAdminCount);
      if (superAdminCount <= 1 && provider?.oauthUser?.isSuperAdmin) {
        return res.status(400).json({ error: 'Cannot remove last super admin' });
      }
    }

    // Update user's roles and increment permission version
    await provider.oauthUser.update({
      isRater: role === 'rater' ? false : provider.oauthUser.isRater,
      isSuperAdmin: role === 'superadmin' ? false : provider.oauthUser.isSuperAdmin,
      permissionVersion: provider.oauthUser.permissionVersion + 1
    });

    // Fetch updated user to ensure we have the latest data
    const updatedUser = await User.findByPk(provider.oauthUser.id, {
      include: [{
        model: OAuthProvider,
        as: 'providers',
        where: { provider: 'discord' },
        required: true
      }]
    });

    if (!updatedUser) {
      throw new Error('Failed to fetch updated user');
    }

    // Generate new token with updated permissions
    const newToken = tokenUtils.generateJWT(updatedUser);

    console.log('Role revoked successfully:', {
      userId: updatedUser.id,
      username: updatedUser.username,
      role,
      newRoles: {
        isRater: updatedUser.isRater,
        isSuperAdmin: updatedUser.isSuperAdmin
      },
      permissionVersion: updatedUser.permissionVersion
    });

    return res.json({
      message: 'Role revoked successfully',
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        discordId,
        isRater: updatedUser.isRater,
        isSuperAdmin: updatedUser.isSuperAdmin
      },
      token: newToken
    });
  } catch (error: any) {
    console.error('Failed to revoke role:', error);
    console.error('Error details:', {
      name: error.name,
      message: error.message,
      stack: error.stack
    });
    return res.status(500).json({ error: 'Failed to revoke role' });
  }
});

// Update user's Discord info
router.post('/sync-discord', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    console.log('Starting Discord info sync');

    const users = await User.findAll({
      include: [{
        model: OAuthProvider,
        as: 'providers',
        where: { provider: 'discord' },
        required: true
      }]
    });

    console.log(`Found ${users.length} users to sync`);

    const updates = [];
    const errors = [];

    for (const user of users) {
      const discordId = user.providers![0].providerId;
      console.log(`Processing user ${user.username} with Discord ID ${discordId}`);
      
      try {
        const discordInfo = await fetchDiscordUserInfo(discordId);
        console.log('Fetched Discord info:', discordInfo);
        
        if (discordInfo.username && discordInfo.username !== user.username) {
          console.log(`Updating username from ${user.username} to ${discordInfo.username}`);
          await user.update({ username: discordInfo.username });
          updates.push(discordId);
        }
      } catch (error) {
        console.error(`Failed to fetch Discord info for ${discordId}:`, error);
        errors.push(discordId);
      }
    }

    console.log('Sync completed:', {
      updatedCount: updates.length,
      failedCount: errors.length,
      updatedIds: updates,
      failedIds: errors
    });

    return res.json({
      message: 'Discord info sync completed',
      updatedCount: updates.length,
      failedIds: errors
    });
  } catch (error: any) {
    console.error('Failed to sync Discord info:', error);
    console.error('Error details:', {
      name: error.name,
      message: error.message,
      stack: error.stack
    });
    return res.status(500).json({ error: 'Failed to sync Discord info' });
  }
});

// Check user roles
router.get('/check/:discordId', async (req: Request, res: Response) => {
  try {
    const { discordId } = req.params;
    console.log('Checking roles for Discord ID:', discordId);

    const users = await User.findAll({
      include: [{
        model: OAuthProvider,
        as: 'providers',
        where: { provider: 'discord' },
        required: true
      }]
    });

    console.log(`Found ${users.length} users to search through`);

    const user = users.find(user => user.providers![0].providerId === discordId);
    console.log('Search result:', user ? `Found user ${user.username}` : 'No user found');

    if (!user) {
      return res.json({ isRater: false, isSuperAdmin: false });
    }

    console.log('Found user roles:', {
      isRater: user.isRater,
      isSuperAdmin: user.isSuperAdmin
    });

    return res.json({
      isRater: user.isRater,
      isSuperAdmin: user.isSuperAdmin
    });
  } catch (error: any) {
    console.error('Failed to check roles:', error);
    console.error('Error details:', {
      name: error.name,
      message: error.message,
      stack: error.stack
    });
    return res.status(500).json({ error: 'Failed to check roles' });
  }
});


// Get user by Discord ID
router.get('/discord/:discordId', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const { discordId } = req.params;
    console.log('Searching for Discord ID:', discordId);

    const users = await User.findAll({
      include: [{
        model: OAuthProvider,
        as: 'providers',
        where: { provider: 'discord' },
        required: true
      }]
    });

    console.log(`Found ${users.length} users to search through`);

    const user = users.find(user => user.providers![0].providerId === discordId);
    console.log('Search result:', user ? `Found user ${user.username}` : 'No user found');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const discordProvider = user.providers![0];
    const discordProfile = discordProvider.profile as { 
      username?: string; 
      avatar?: string;
    } || {};

    console.log('Found user details:', {
      id: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl,
      discordProfile
    });

    return res.json({
      id: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl
    });
  } catch (error: any) {
    console.error('Error fetching user by Discord ID:', error);
    console.error('Error details:', {
      name: error.name,
      message: error.message,
      stack: error.stack
    });
    return res.status(500).json({ error: 'Failed to fetch user' });
  }
});


export default router; 