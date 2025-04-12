import {User, OAuthProvider} from '../models/index.js';
import {v4 as uuidv4} from 'uuid';
import {UserAttributes} from '../models/User.js';
import {raterList, SUPER_ADMINS} from '../config/constants.js';
import Player from '../models/Player.js';

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
    console.log('[OAuthService] Finding or creating user for profile:', {
      provider: profile.provider,
      providerId: profile.id,
      username: profile.username,
      email: profile.email
    });

    // First check if provider is already linked
    const provider = await OAuthProvider.findOne({
      where: {
        provider: profile.provider,
        providerId: profile.id,
      },
      include: [{model: User, as: 'oauthUser', include: [{model: Player, as: 'player'}]}],
    });
    console.log(provider);

    if (provider?.oauthUser) {
      console.log('[OAuthService] Found existing provider link for user:', {
        userId: provider.oauthUser.id,
        username: provider.oauthUser.username
      });

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
        console.log('[OAuthService] Updating user profile:', updates);
        await provider.oauthUser.update(updates);
      }

      return [provider.oauthUser, false];
    }

    console.log('[OAuthService] No existing provider link found, checking for user by email');

    // If no provider link exists, check for existing user by email
    let user: User | null = null;
    if (profile.email) {
      user = await User.findOne({
        where: {email: profile.email},
        include: [{model: OAuthProvider, as: 'providers'}],
      });

      if (user) {
        console.log('[OAuthService] Found existing user by email:', {
          userId: user.id,
          username: user.username
        });
      }
    }

    // Create new user if none exists
    if (!user) {
      console.log('[OAuthService] Creating new user');
      const now = new Date();
      const isRater =
        profile.provider === 'discord' &&
        (raterList.includes(profile.id) ||
          SUPER_ADMINS.includes(profile.username));
      const isSuperAdmin =
        profile.provider === 'discord' && SUPER_ADMINS.includes(profile.username);

      try {
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
          createdAt: now,
          updatedAt: now,
        });

        console.log('[OAuthService] Successfully created new user:', {
          userId: user.id,
          username: user.username
        });

        // Create OAuth provider link
        const oauthProvider = await OAuthProvider.create({
          userId: user.id,
          provider: profile.provider,
          providerId: profile.id,
          profile: profile,
          createdAt: now,
          updatedAt: now,
        });

        console.log('[OAuthService] Successfully created OAuth provider link:', {
          providerId: oauthProvider.id,
          userId: user.id,
          provider: profile.provider
        });

        return [user, true];
      } catch (error) {
        console.error('[OAuthService] Error creating user:', error);
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
    console.log('[OAuthService] Linking provider to user:', {
      userId,
      provider: profile.provider,
      providerId: profile.id
    });

    // Check if provider is already linked to any user
    const existingProvider = await OAuthProvider.findOne({
      where: {
        provider: profile.provider,
        providerId: profile.id,
      },
    });

    if (existingProvider) {
      console.log('[OAuthService] Provider already linked to another user:', {
        providerId: existingProvider.id,
        userId: existingProvider.userId
      });
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
      console.log('[OAuthService] User already has this provider type linked:', {
        providerId: userProvider.id,
        userId
      });
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
        console.log('[OAuthService] Updating user permissions:', {
          userId,
          isRater,
          isSuperAdmin
        });
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

      console.log('[OAuthService] Successfully linked provider to user:', {
        providerId: oauthProvider.id,
        userId,
        provider: profile.provider
      });

      return oauthProvider;
    } catch (error) {
      console.error('[OAuthService] Error linking provider:', error);
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
