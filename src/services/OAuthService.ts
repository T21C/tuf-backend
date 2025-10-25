import {User, OAuthProvider} from '../models/index.js';
import {v4 as uuidv4} from 'uuid';
import {UserAttributes} from '../models/auth/User.js';
import Player from '../models/players/Player.js';
import { logger } from './LoggerService.js';

interface OAuthProfile {
  id: string;
  provider: string;
  email?: string;
  username: string;
  nickname?: string;
  avatarId?: string;
  avatarUrl?: string;
  [key: string]: any;
}

class OAuthService {
  /**
   * Find or create a user based on OAuth profile for login
   */
  async findOrCreateUser(profile: OAuthProfile): Promise<[User, boolean]> {
    // First check if provider is already linked
    const provider = await OAuthProvider.findOne({
      where: {
        provider: profile.provider,
        providerId: profile.id,
      },
      include: [{model: User, as: 'oauthUser', include: [{model: Player, as: 'player'}]}],
    });
    if (provider?.oauthUser) {
      // Update user profile if needed
      const updates: Partial<UserAttributes> = {};
      if (
        profile.nickname &&
        (!provider.oauthUser.nickname ||
          provider.oauthUser.nickname !== profile.nickname)
      ) {
        updates.nickname = profile.nickname;
      }
      if (
        profile.avatarId &&
        (!provider.oauthUser.avatarId ||
          provider.oauthUser.avatarId !== profile.avatarId)
      ) {
        updates.avatarId = profile.avatarId;
        updates.avatarUrl = profile.avatarUrl;
      }

      if (Object.keys(updates).length > 0) {
        await provider.oauthUser.update(updates);
      }

      return [provider.oauthUser, false];
    }

    // If no provider link exists, check for existing user by email
    let user: User | null = null;
    if (profile.email) {
      user = await User.findOne({
        where: {email: profile.email},
        include: [{model: OAuthProvider, as: 'providers'}],
      });
      
      // If user exists but doesn't have this provider linked, link it
      if (user) {
        const now = new Date();
        await OAuthProvider.create({
          userId: user.id,
          provider: profile.provider,
          providerId: profile.id,
          profile: profile,
          createdAt: now,
          updatedAt: now,
        });
        
        return [user, false];
      }
    }

    // Create new user if none exists
    if (!user) {
      const now = new Date();

      try {
        // Check if there's a player mapping for this Discord ID
        let playerId: number | undefined;

        let playerName = profile.username;
        let attempts = 0;
        const maxAttempts = 5;
        while (attempts < maxAttempts) {
          try {
            const player = await Player.create({
              name: playerName,
              country: 'XX', // Default country
              isBanned: false,
              isSubmissionsPaused: false,
              createdAt: now,
              updatedAt: now
            });
            playerId = player.id;
            break;
          } catch (error: any) {
            if (error.name === 'SequelizeUniqueConstraintError' && error.errors?.[0]?.path === 'name') {
              // If name is duplicate, append a random number and try again
              playerName = `${profile.username}${Math.floor(Math.random() * 10000)}`;
              attempts++;
              continue;
            }
            throw error;
          }
        }
        if (!playerId) {
          throw new Error('Failed to create player after multiple attempts');
        }

        // Try to create user with retry logic for username conflicts
        let username = profile.username;
        let userAttempts = 0;
        const maxUserAttempts = 5;
        while (userAttempts < maxUserAttempts) {
          try {
            user = await User.create({
              id: uuidv4(),
              username: username,
              email: profile.email || undefined,
              nickname: profile.nickname,
              avatarId: profile.avatarId,
              avatarUrl: profile.avatarUrl,
              isEmailVerified: !!profile.email,
              isRater: false,
              isSuperAdmin: false,
              isRatingBanned: false,
              status: 'active',
              permissionVersion: 1,
              playerId,
              createdAt: now,
              updatedAt: now,
              permissionFlags: 0,
            });
            break;
          } catch (error: any) {
            if (error.name === 'SequelizeUniqueConstraintError' && error.errors?.[0]?.path === 'username') {
              // If username is duplicate, append a random number and try again
              username = `${profile.username}${Math.floor(Math.random() * 10000)}`;
              userAttempts++;
              continue;
            }
            throw error;
          }
        }

        if (!user) {
          throw new Error('Failed to create user after multiple attempts');
        }

        // Create OAuth provider link
        await OAuthProvider.create({
          userId: user.id,
          provider: profile.provider,
          providerId: profile.id,
          profile: profile,
          createdAt: now,
          updatedAt: now,
        });

        return [user, true];
      } catch (error) {
        logger.error('[OAuthService] Error creating user:', error);
        throw error;
      }
    }

    return [user, false];
  }

  /**
   * Link an OAuth provider to existing user
   */
  async linkProvider(
    userId: string,
    profile: OAuthProfile,
  ): Promise<OAuthProvider> {

    // Check if provider is already linked to any user
    const existingProvider = await OAuthProvider.findOne({
      where: {
        provider: profile.provider,
        providerId: profile.id,
      },
    });

    if (existingProvider) {

      throw new Error(
        'This provider account is already linked to another user',
      );
    }

    // Check if user already has this provider type linked
    const userProvider = await OAuthProvider.findOne({
      where: {
        userId,
        provider: profile.provider,
      },
    });

    if (userProvider) {

      throw new Error(
        'This user already has a different account linked for this provider',
      );
    }

    try {
      const now = new Date();
      const oauthProvider = await OAuthProvider.create({
        userId,
        provider: profile.provider,
        providerId: profile.id,
        profile: profile,
        createdAt: now,
        updatedAt: now,
      });



      return oauthProvider;
    } catch (error) {
      logger.error('[OAuthService] Error linking provider:', error);
      throw error;
    }
  }

  /**
   * Update OAuth tokens
   */
  async updateTokens(
    provider: string,
    providerId: string,
    accessToken: string,
    refreshToken?: string,
    tokenExpiry?: Date,
  ): Promise<void> {
    await OAuthProvider.update(
      {
        accessToken,
        refreshToken,
        tokenExpiry,
      },
      {
        where: {
          provider,
          providerId,
        },
      },
    );
  }

  /**
   * Get all OAuth providers for a user
   */
  async getUserProviders(userId: string): Promise<OAuthProvider[]> {
    return OAuthProvider.findAll({
      where: {userId},
    });
  }

  /**
   * Unlink an OAuth provider from user
   */
  async unlinkProvider(userId: string, provider: string): Promise<boolean> {
    const result = await OAuthProvider.destroy({
      where: {
        userId,
        provider,
      },
    });
    return result > 0;
  }

  /**
   * Find user by provider details
   */
  async findUserByProvider(
    provider: string,
    providerId: string,
  ): Promise<User | null> {
    const oauthProvider = await OAuthProvider.findOne({
      where: {
        provider,
        providerId,
      },
      include: [{model: User, as: 'user'}],
    });

    return oauthProvider?.oauthUser || null;
  }
}

export default new OAuthService();
