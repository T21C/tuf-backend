import {User, OAuthProvider} from '../models/index.js';
import {v4 as uuidv4} from 'uuid';
import {UserAttributes} from '../models/auth/User.js';
import {raterList, SUPER_ADMINS} from '../config/constants.js';
import Player from '../models/players/Player.js';
import {findPlayerByDiscordId} from '../utils/playerMapping.js';
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
    }

    // Create new user if none exists
    if (!user) {
      const now = new Date();
      const isRater =
        profile.provider === 'discord' &&
        (raterList.includes(profile.id) ||
          SUPER_ADMINS.includes(profile.username));
      const isSuperAdmin =
        profile.provider === 'discord' && SUPER_ADMINS.includes(profile.username);

      try {
        // Check if there's a player mapping for this Discord ID
        let playerId: number | undefined;
        if (profile.provider === 'discord') {
          const playerMapping = findPlayerByDiscordId(profile.id);
          if (playerMapping) {
            // Find the player by name
            const player = await Player.findOne({
              where: { name: playerMapping.name }
            });
            if (player) {
              playerId = player.id;
            }
          }
        }

        // If no player found, create a new one
        if (!playerId) {
          const player = await Player.create({
            name: profile.username,
            country: 'XX', // Default country
            isBanned: false,
            isSubmissionsPaused: false,
            createdAt: now,
            updatedAt: now
          });
          playerId = player.id;
        }

        user = await User.create({
          id: uuidv4(),
          username: profile.username,
          email: profile.email || undefined,
          nickname: profile.nickname,
          avatarId: profile.avatarId,
          avatarUrl: profile.avatarUrl,
          isEmailVerified: !!profile.email,
          isRater,
          isSuperAdmin,
          isRatingBanned: false,
          status: 'active',
          permissionVersion: 1,
          playerId,
          createdAt: now,
          updatedAt: now,
        });

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

    // Update permissions if linking Discord account
    if (profile.provider === 'discord') {
      const isRater =
        raterList.includes(profile.id) ||
        SUPER_ADMINS.includes(profile.username);
      const isSuperAdmin = SUPER_ADMINS.includes(profile.username);
      if (isRater || isSuperAdmin) {

        await User.update(
          {
            isRater,
            isSuperAdmin,
          },
          {
            where: {id: userId},
          },
        );
      }
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
