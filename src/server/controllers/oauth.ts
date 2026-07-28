import {Request, Response} from 'express';
import OAuthService from '@/server/services/accounts/OAuthService.js';
import {OAuthProvider} from '@/models/index.js';
import axios from 'axios';
import {
  type RESTPostOAuth2AccessTokenResult,
  type RESTGetAPIUserResult,
} from 'discord-api-types/v10';
import dotenv from 'dotenv';
import { logger } from '@/server/services/core/LoggerService.js';
import { clientUrlEnv, ownUrl, isTufStellarFeatureEnabled } from '@/config/app.config.js';
import { hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import { permissionFlags } from '@/config/constants.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import User from '@/models/auth/User.js';
import {
  reconcileExpiredTufStellarAccess,
} from '@/misc/utils/subscriptions/tufStellarSubscription.js';
import {
  stepUpGrantService,
  isStepUpScope,
  type StepUpScope,
} from '@/server/services/auth/StepUpGrantService.js';
import { sessionIssuanceService } from '@/server/services/auth/SessionIssuanceService.js';
import { hasPasswordCredential } from '@/server/services/auth/passwordCredential.js';
import { parseClientIp } from '@/misc/utils/auth/rateLimitSubjects.js';
import { loadUserTufStellarBilling } from '@/server/services/billing/userTufStellarBillingSupport.js';
import { securityNotificationService } from '@/server/services/accounts/SecurityNotificationService.js';


interface ProfileResponse {
  user: {
    id: string;
    username: string;
    nickname: string | null;
    email?: string | null;
    avatarUrl: string | null;
    tufStellarSubscriptionExpiresAt: Date | null;
    tufStellarEnabled: boolean;
    isRater: boolean;
    isSuperAdmin: boolean;
    isEmailVerified: boolean;
    permissionFlags: string;
  };
  providers: {
    provider: string;
    providerId: string;
  }[];
}

dotenv.config();

function parseStepUpScopeParam(raw: unknown): StepUpScope {
  if (raw == null || raw === '') return 'email-change';
  if (isStepUpScope(raw)) return raw;
  return 'email-change';
}

function buildDiscordRedirectUri(mode: 'login' | 'linking' | 'reauth'): string {
  if (mode === 'linking') return clientUrlEnv + '/callback?linking=true';
  if (mode === 'reauth') return clientUrlEnv + '/callback?reauth=true';
  return clientUrlEnv + '/callback';
}

// Helper function to handle Discord OAuth token exchange
async function handleDiscordOAuth(
  code: string,
  mode: 'login' | 'linking' | 'reauth',
): Promise<{
  tokens: RESTPostOAuth2AccessTokenResult;
  profile: RESTGetAPIUserResult;
} | null> {
  try {
    const tokenResponse = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID!,
        client_secret: process.env.DISCORD_CLIENT_SECRET!,
        code: code.toString(),
        grant_type: 'authorization_code',
        redirect_uri: buildDiscordRedirectUri(mode),
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
    );

    const tokens: RESTPostOAuth2AccessTokenResult = tokenResponse.data;
    const userResponse = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    return {
      tokens,
      profile: userResponse.data,
    };
  } catch {
    return null;
  }
}

export const OAuthController = {
  /**
   * Initiate OAuth login process
   */
  async initiateLogin(req: Request, res: Response) {
    const {provider} = req.params;

    if (provider === 'discord') {
      if (!process.env.DISCORD_CLIENT_ID) {
        logger.error('DISCORD_CLIENT_ID is not set');
        return res.status(500).json({error: 'Discord client ID is not configured'});
      }

      const scopes = ['identify', 'email'];
      const redirectUri = buildDiscordRedirectUri('login');

      const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${
        process.env.DISCORD_CLIENT_ID
      }&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scopes.join('%20')}`;

      return res.json({url: authUrl});
    }

    return res.status(400).json({error: 'Unsupported provider'});
  },

  /**
   * Initiate OAuth linking process
   */
  async initiateLink(req: Request, res: Response) {
    const {provider} = req.params;

    if (provider === 'discord') {
      const scopes = ['identify', 'email'];
      const redirectUri = buildDiscordRedirectUri('linking');
      const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${
        process.env.DISCORD_CLIENT_ID
      }&redirect_uri=${encodeURIComponent(
        redirectUri,
      )}&response_type=code&scope=${scopes.join('%20')}`;
      return res.json({url: authUrl});
    }

    return res.status(400).json({error: 'Unsupported provider'});
  },

  /**
   * Initiate OAuth reauth for step-up (OAuth-only accounts).
   * Optional query `scope` selects the step-up grant scope (default email-change).
   * Scope is echoed to the client and passed back on the API callback (not in the Discord redirect_uri).
   */
  async initiateReauth(req: Request, res: Response) {
    const { provider } = req.params;
    const scope = parseStepUpScopeParam(req.query.scope);
    if (provider === 'discord') {
      const scopes = ['identify', 'email'];
      const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${
        process.env.DISCORD_CLIENT_ID
      }&redirect_uri=${encodeURIComponent(
        buildDiscordRedirectUri('reauth'),
      )}&response_type=code&scope=${scopes.join('%20')}`;
      return res.json({ url: authUrl, scope });
    }
    return res.status(400).json({ error: 'Unsupported provider' });
  },

  /**
   * Handle OAuth callback
   */
  async handleCallback(req: Request, res: Response) {
    try {
      //const {provider} = req.params;
      const {code} = req.body;
      const isLinking = req.query.linking === 'true';
      const isReauth = req.query.reauth === 'true';
      const stepUpScope = parseStepUpScopeParam(req.query.scope);

      if (!code) {
        return res
          .status(400)
          .json({message: 'Authorization code is required'});
      }

      const tokens = await handleDiscordOAuth(
        code.toString(),
        isLinking ? 'linking' : isReauth ? 'reauth' : 'login',
      );
      //logger.error("Discord OAuth tokens", tokens)
      if (!tokens) {
        return res
          .status(400)
          .json({message: 'Failed to exchange code for tokens'});
      }

      // Get user profile from provider
      const profile = tokens.profile;
      if (!profile) {
        return res.status(400).json({message: 'Failed to get user profile'});
      }
      if (isReauth) {
        if (!req.user) {
          return res.status(401).json({ message: 'Authentication required for reauth' });
        }
        // Ensure the Discord account is linked to this user
        const linked = await OAuthProvider.findOne({
          where: {
            userId: req.user.id,
            provider: 'discord',
            providerId: profile.id,
          },
        });
        if (!linked) {
          return res.status(403).json({
            message: 'Discord account does not match a linked provider on this account',
            code: 'OAUTH_REAUTH_MISMATCH',
          });
        }
        await stepUpGrantService.grantAfterOAuthReauth(req.user.id, res, stepUpScope, {
          ip: parseClientIp(req),
          userAgent: req.get('user-agent') ?? undefined,
        });
        return res.json({ success: true, stepUp: true, scope: stepUpScope });
      }

      if (isLinking) {
        // Handle linking flow
        if (!req.user) {
          return res.status(401).json({message: 'Authentication required for linking'});
        }

        try {
          await OAuthService.linkProvider(req.user.id, {
            id: profile.id,
            provider: 'discord',
            username: profile.username,
            email: profile.email || undefined,
          });

          // Invalidate user-specific cache
          await CacheInvalidation.invalidateUser(req.user.id);

          return res.json({success: true});
        } catch (error: any) {
          if (error.message.includes('ERR_BAD_REQUEST') || (error.response && error.response.status === 400)) {
            return res.status(400).json({error: 'Invalid code'});
          }
          logger.error('Provider linking error:', error);
          return res.status(400).json({error: error.message || 'Failed to link provider'});
        }
      } else {
        // Handle login flow
        const [user, isNew] = await OAuthService.findOrCreateUser({
          id: profile.id,
          provider: 'discord',
          username: profile.username,
          email: profile.email || undefined,
        });

        // Invalidate user-specific cache (for new users, this is a no-op but harmless)
        await CacheInvalidation.invalidateUser(user.id);

        const auth = await sessionIssuanceService.completeAuthentication(user, req, res, {
          mfaExempt: true,
        });
        if (auth.status !== 'session') {
          return res.status(500).json({ message: 'Authentication failed' });
        }
        if (!isNew) {
          securityNotificationService.notify(user.id, 'new-signin', {
            req,
            method: 'discord',
          });
        }
        return res.json({
          user: auth.user,
          isNew,
          expiresIn: auth.expiresIn,
          sessionId: auth.sessionId,
        });
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('400')) {
        return res.status(400).json({message: 'Bad authentication code'});
      }
      //logger.error('OAuth callback error:', error);
      return res.status(500).json({message: 'Authentication failed'});
    }
  },

  /**
   * Get user profile
   */
  async getProfile(req: Request, res: Response) {
    try {
      const providers = await OAuthService.getUserProviders(req.user!.id);

      let userRow = await User.findByPk(req.user!.id);
      if (userRow) {
        await reconcileExpiredTufStellarAccess(userRow);
        await userRow.reload();
      } else {
        userRow = req.user as User;
      }

      const billingRow = await loadUserTufStellarBilling(userRow.id);

      const avatarUrl = userRow.avatarUrl
        ? userRow.playerId
          ? `${ownUrl}/v2/media/player-avatar/${userRow.playerId}`
          : `${ownUrl}/v2/media/avatar/${userRow.id}`
        : null;

      const stellarOn = isTufStellarFeatureEnabled();
      const response: ProfileResponse = {
        user: {
          id: userRow.id,
          username: userRow.username,
          nickname: userRow.nickname || null,
          email: userRow.email,
          avatarUrl,
          tufStellarSubscriptionExpiresAt: stellarOn ? (billingRow?.tufStellarSubscriptionExpiresAt ?? null) : null,
          tufStellarEnabled: stellarOn,
          isRater: hasFlag(userRow, permissionFlags.RATER),
          isSuperAdmin: hasFlag(userRow, permissionFlags.SUPER_ADMIN),
          isEmailVerified: hasFlag(userRow, permissionFlags.EMAIL_VERIFIED),
          permissionFlags: userRow.permissionFlags.toString(),
        },
        providers: providers.map((p: OAuthProvider) => ({
          provider: p.provider,
          providerId: p.providerId,
        })),
      };

      return res.json(response);
    } catch (error) {
      logger.error('Profile fetch error:', error);
      return res.status(500).json({error: 'Failed to fetch profile'});
    }
  },

  /**
   * Link provider to user account
   */
  async linkProvider(req: Request, res: Response) {
    const {provider} = req.params;
    const {code} = req.body;

    if (!code) {
      return res.status(400).json({error: 'Authorization code required'});
    }

    try {
      if (provider === 'discord') {
        const result = await handleDiscordOAuth(code, 'linking');
        //logger.error("Discord OAuth linking result", result)
        if (!result) {
          return res.status(400).json({error: 'Failed to exchange code for tokens'});
        }
        const {profile} = result;

        // Check if this provider is already linked to another user
        const existingProvider = await OAuthProvider.findOne({
          where: {
            provider: 'discord',
            providerId: profile.id,
          },
        });

        if (existingProvider) {
          return res.status(400).json({
            error: 'This Discord account is already linked to another user',
          });
        }

        // Link provider to user
        await OAuthService.linkProvider(req.user!.id, {
          id: profile.id,
          provider: 'discord',
          username: profile.username,
          email: profile.email || undefined,
        });

        // Invalidate user-specific cache
        await CacheInvalidation.invalidateUser(req.user!.id);

        return res.json({success: true});
      }

      return res.status(400).json({error: 'Unsupported provider'});
    } catch (error) {
      logger.error('Provider linking error:', error);
      return res.status(500).json({error: 'Failed to link provider'});
    }
  },

  /**
   * Unlink provider from user account
   */
  async unlinkProvider(req: Request, res: Response) {
    const {provider} = req.params;

    try {
      const providers = await OAuthService.getUserProviders(req.user!.id);

      if (providers.length <= 1 && !(await hasPasswordCredential(req.user!.id))) {
        return res
          .status(400)
          .json({error: 'Cannot remove last authentication provider without a password'});
      }

      const success = await OAuthService.unlinkProvider(req.user!.id, provider);

      // Invalidate user-specific cache
      await CacheInvalidation.invalidateUser(req.user!.id);

      return res.json({success});
    } catch (error) {
      logger.error('Provider unlinking error:', error);
      return res.status(500).json({error: 'Failed to unlink provider'});
    }
  },
};
