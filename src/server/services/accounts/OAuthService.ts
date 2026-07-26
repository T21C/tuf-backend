import { User, OAuthProvider } from '@/models/index.js';
import { v4 as uuidv4 } from 'uuid';
import { UserAttributes } from '@/models/auth/User.js';
import Player from '@/models/players/Player.js';
import { logger } from '../core/LoggerService.js';
import { mapMysqlClientError } from '@/misc/utils/db/mysqlClientError.js';
import {
  isValidUsername,
  normalizeUsername,
  sanitizeUsername,
  USERNAME_MAX_LEN,
} from '@/misc/utils/auth/username.js';
import { accountCredentialService } from '@/server/services/accounts/AccountCredentialService.js';
import { permissionFlags } from '@/config/constants.js';

interface OAuthProfile {
  id: string;
  provider: string;
  email?: string;
  username: string;
  nickname?: string;
  avatarId?: string;
  avatarUrl?: string;
  [key: string]: unknown;
}

class OAuthService {
  /**
   * Find or create a user based on OAuth profile for login.
   * Email policy: only link to verified `email` owners; never auto-link into pending-only accounts.
   * New OAuth users get verified email; foreign pending claims on that address are cleared.
   */
  async findOrCreateUser(profile: OAuthProfile): Promise<[User, boolean]> {
    const provider = await OAuthProvider.findOne({
      where: {
        provider: profile.provider,
        providerId: profile.id,
      },
      include: [{ model: User, as: 'oauthUser', include: [{ model: Player, as: 'player' }] }],
    });

    if (provider?.oauthUser) {
      const updates: Partial<UserAttributes> = {};
      if (
        profile.nickname &&
        (!provider.oauthUser.nickname || provider.oauthUser.nickname !== profile.nickname)
      ) {
        updates.nickname = profile.nickname;
      }
      if (
        profile.avatarId &&
        (!provider.oauthUser.avatarId || provider.oauthUser.avatarId !== profile.avatarId)
      ) {
        updates.avatarId = profile.avatarId;
        updates.avatarUrl = profile.avatarUrl;
      }
      if (Object.keys(updates).length > 0) {
        await provider.oauthUser.update(updates);
      }
      if (profile.email) {
        await accountCredentialService.ensureEmailVerifiedFlag(provider.oauthUser);
      }
      return [provider.oauthUser, false];
    }

    const normalizedEmail = profile.email
      ? accountCredentialService.normalizeEmail(profile.email)
      : '';

    // Link only to verified email owners
    if (normalizedEmail) {
      const verifiedOwner = await User.findOne({
        where: { email: normalizedEmail },
        include: [{ model: OAuthProvider, as: 'providers' }],
      });

      if (verifiedOwner) {
        const now = new Date();
        await OAuthProvider.create({
          userId: verifiedOwner.id,
          provider: profile.provider,
          providerId: profile.id,
          createdAt: now,
          updatedAt: now,
        });
        await accountCredentialService.ensureEmailVerifiedFlag(verifiedOwner);
        await accountCredentialService.logAction(verifiedOwner.id, 'oauth_link', {
          provider: profile.provider,
        });
        return [verifiedOwner, false];
      }

      // Do not merge into pending squatters — clear their pending and create/claim for OAuth user
      await accountCredentialService.clearForeignPendingEmail(normalizedEmail);
    }

    const now = new Date();
    try {
      let playerId: number | undefined;
      const desiredNickname = profile.username;
      const normalizedDiscordName = normalizeUsername(desiredNickname);
      const canonicalFromDiscord = isValidUsername(normalizedDiscordName)
        ? normalizedDiscordName
        : sanitizeUsername(desiredNickname);
      let playerName = canonicalFromDiscord;
      let attempts = 0;
      const maxAttempts = 5;

      while (attempts < maxAttempts) {
        try {
          const player = await Player.create({
            name: playerName,
            country: 'XX',
            isBanned: false,
            isSubmissionsPaused: false,
            createdAt: now,
            updatedAt: now,
          });
          playerId = player.id;
          break;
        } catch (error: unknown) {
          const err = error as { errors?: { path?: string }[] };
          if (
            mapMysqlClientError(error)?.code === 'ER_DUP_ENTRY' &&
            err.errors?.[0]?.path === 'name'
          ) {
            const suffix = String(Math.floor(Math.random() * 10000));
            playerName = `${canonicalFromDiscord.slice(0, Math.max(0, USERNAME_MAX_LEN - suffix.length))}${suffix}`;
            attempts++;
            continue;
          }
          throw error;
        }
      }
      if (!playerId) {
        throw new Error('Failed to create player after multiple attempts');
      }

      let username = canonicalFromDiscord;
      let userAttempts = 0;
      const maxUserAttempts = 5;
      let user: User | null = null;

      const initialFlags = normalizedEmail ? permissionFlags.EMAIL_VERIFIED : 0;

      while (userAttempts < maxUserAttempts) {
        try {
          user = await User.create({
            id: uuidv4(),
            username,
            email: null,
            pendingEmail: null,
            nickname: profile.nickname || desiredNickname,
            avatarId: profile.avatarId,
            avatarUrl: profile.avatarUrl,
            isEmailVerified: false,
            isRater: false,
            isSuperAdmin: false,
            isRatingBanned: false,
            status: 'active',
            permissionVersion: 1,
            playerId,
            createdAt: now,
            updatedAt: now,
            permissionFlags: initialFlags,
          });
          break;
        } catch (error: unknown) {
          const err = error as { errors?: { path?: string }[] };
          if (
            mapMysqlClientError(error)?.code === 'ER_DUP_ENTRY' &&
            err.errors?.[0]?.path === 'username'
          ) {
            const suffix = String(Math.floor(Math.random() * 10000));
            username = `${canonicalFromDiscord.slice(0, Math.max(0, USERNAME_MAX_LEN - suffix.length))}${suffix}`;
            userAttempts++;
            continue;
          }
          throw error;
        }
      }

      if (!user) {
        throw new Error('Failed to create user after multiple attempts');
      }

      if (normalizedEmail) {
        await accountCredentialService.assignVerifiedEmailFromOAuth(user, normalizedEmail);
        await user.reload();
      }

      await OAuthProvider.create({
        userId: user.id,
        provider: profile.provider,
        providerId: profile.id,
        createdAt: now,
        updatedAt: now,
      });

      await accountCredentialService.logAction(user.id, 'oauth_link', {
        provider: profile.provider,
        created: true,
      });

      return [user, true];
    } catch (error) {
      logger.error('[OAuthService] Error creating user:', error);
      throw error;
    }
  }

  async linkProvider(userId: string, profile: OAuthProfile): Promise<OAuthProvider> {
    const existingProvider = await OAuthProvider.findOne({
      where: {
        provider: profile.provider,
        providerId: profile.id,
      },
    });

    if (existingProvider) {
      throw new Error('This provider account is already linked to another user');
    }

    const userProvider = await OAuthProvider.findOne({
      where: {
        userId,
        provider: profile.provider,
      },
    });

    if (userProvider) {
      throw new Error('This user already has a different account linked for this provider');
    }

    try {
      const now = new Date();
      const oauthProvider = await OAuthProvider.create({
        userId,
        provider: profile.provider,
        providerId: profile.id,
        createdAt: now,
        updatedAt: now,
      });
      await accountCredentialService.logAction(userId, 'oauth_link', {
        provider: profile.provider,
      });
      return oauthProvider;
    } catch (error) {
      logger.error('[OAuthService] Error linking provider:', error);
      throw error;
    }
  }

  async getUserProviders(userId: string): Promise<OAuthProvider[]> {
    return OAuthProvider.findAll({ where: { userId } });
  }

  async unlinkProvider(userId: string, provider: string): Promise<boolean> {
    const result = await OAuthProvider.destroy({
      where: { userId, provider },
    });
    if (result > 0) {
      await accountCredentialService.logAction(userId, 'oauth_unlink', { provider });
    }
    return result > 0;
  }

  async findUserByProvider(provider: string, providerId: string): Promise<User | null> {
    const oauthProvider = await OAuthProvider.findOne({
      where: { provider, providerId },
      include: [{ model: User, as: 'user' }],
    });
    return oauthProvider?.oauthUser || null;
  }
}

export default new OAuthService();
