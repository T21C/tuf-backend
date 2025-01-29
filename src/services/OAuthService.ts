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
   * Find or create a user based on OAuth profile
   */
  async findOrCreateUser(profile: OAuthProfile): Promise<[User, boolean]> {
    // First check if provider is already linked
    const provider = await OAuthProvider.findOne({
      where: {
        provider: profile.provider,
        providerId: profile.id,
      },
      include: [{model: User, include: [{model: Player, as: 'player'}]}],
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

    // If user exists, link the provider if not already linked
    if (user) {
      // Check if this provider is already linked
      const existingProvider = user.providers?.find(
        (p: any) =>
          p.provider === profile.provider && p.providerId === profile.id,
      );

      if (!existingProvider) {
        await OAuthProvider.create({
          userId: user.id,
          provider: profile.provider,
          providerId: profile.id,
          profile: profile,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      // Update user profile if needed
      const updates: Partial<UserAttributes> = {};
      if (
        profile.nickname &&
        (!user.nickname || user.nickname !== profile.nickname)
      ) {
        updates.nickname = profile.nickname;
      }
      if (
        profile.avatarId &&
        (!user.avatarId || user.avatarId !== profile.avatarId)
      ) {
        updates.avatarId = profile.avatarId;
        updates.avatarUrl = profile.avatarUrl;
      }

      if (Object.keys(updates).length > 0) {
        await user.update(updates);
      }

      return [user, false];
    }

    // Create new user
    const now = new Date();
    const isRater =
      profile.provider === 'discord' &&
      (raterList.includes(profile.id) ||
        SUPER_ADMINS.includes(profile.username));
    const isSuperAdmin =
      profile.provider === 'discord' && SUPER_ADMINS.includes(profile.username);

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
      status: 'active',
      permissionVersion: 1,
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
  }

  /**
   * Link an OAuth provider to existing user
   */
  async linkProvider(
    userId: string,
    profile: OAuthProfile,
  ): Promise<OAuthProvider> {
    // Check if provider is already linked to another user
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

    const now = new Date();
    return OAuthProvider.create({
      userId,
      provider: profile.provider,
      providerId: profile.id,
      profile: profile,
      createdAt: now,
      updatedAt: now,
    });
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
