import {Request, Response} from 'express';
import OAuthService from '@/server/services/accounts/OAuthService.js';
import {OAuthProvider} from '@/models/index.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { ownUrl, isTufStellarFeatureEnabled } from '@/config/app.config.js';
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
import { oauthPendingService } from '@/server/services/auth/OAuthPendingService.js';
import { getOAuthProviderAdapter } from '@/server/services/accounts/oauthProviders/registry.js';
import { oauthCallbackRedirectUri } from '@/server/services/accounts/oauthProviders/redirectUri.js';
import {
  isOAuthEmailRequiredError,
  type OAuthMode,
} from '@/server/services/accounts/oauthProviders/types.js';

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

function parseStepUpScopeParam(raw: unknown): StepUpScope {
  if (raw === null || raw === undefined || raw === '') return 'email-change';
  if (isStepUpScope(raw)) return raw;
  return 'email-change';
}

async function initiateOAuth(
  req: Request,
  res: Response,
  mode: OAuthMode,
): Promise<Response> {
  const adapter = getOAuthProviderAdapter(req.params.provider);
  if (!adapter) {
    return res.status(400).json({error: 'Unsupported provider'});
  }

  if (mode !== 'login' && !req.user) {
    return res.status(401).json({message: 'Authentication required'});
  }

  const scope = mode === 'reauth' ? parseStepUpScopeParam(req.query.scope) : undefined;

  try {
    const nonce = oauthPendingService.issue(res, {
      provider: adapter.id,
      mode,
      userId: mode === 'login' ? undefined : req.user!.id,
      scope,
    });
    const url = adapter.buildAuthorizeUrl({
      redirectUri: oauthCallbackRedirectUri(),
      state: nonce,
      mode,
    });
    if (mode === 'reauth') {
      return res.json({url, scope});
    }
    return res.json({url});
  } catch (error) {
    logger.error(`[OAuth] Failed to initiate ${mode} for ${adapter.id}:`, error);
    return res.status(500).json({error: 'OAuth provider is not configured'});
  }
}

export const OAuthController = {
  async initiateLogin(req: Request, res: Response) {
    return initiateOAuth(req, res, 'login');
  },

  async initiateLink(req: Request, res: Response) {
    return initiateOAuth(req, res, 'linking');
  },

  /**
   * Initiate OAuth reauth for step-up (OAuth-only accounts).
   * Optional query `scope` selects the step-up grant scope (default email-change).
   */
  async initiateReauth(req: Request, res: Response) {
    return initiateOAuth(req, res, 'reauth');
  },

  async handleCallback(req: Request, res: Response) {
    const pending = oauthPendingService.read(req);
    oauthPendingService.clear(res);
    const mode = pending?.mode;

    try {
      const {code, state} = req.body ?? {};

      if (!pending) {
        return res.status(400).json({
          message: 'OAuth session expired or missing',
          code: 'OAUTH_PENDING_MISSING',
        });
      }

      if (!oauthPendingService.matchesState(pending, state)) {
        return res.status(400).json({
          message: 'Invalid OAuth state',
          code: 'OAUTH_STATE_MISMATCH',
          mode,
        });
      }

      if (!code) {
        return res
          .status(400)
          .json({message: 'Authorization code is required', mode});
      }

      if (pending.mode === 'linking' || pending.mode === 'reauth') {
        if (!req.user) {
          return res.status(401).json({
            message: 'Authentication required for this OAuth flow',
            mode,
          });
        }
        if (!pending.sub || pending.sub !== req.user.id) {
          return res.status(403).json({
            message: 'OAuth session does not match this account',
            code: 'OAUTH_PENDING_USER_MISMATCH',
            mode,
          });
        }
      }

      const adapter = getOAuthProviderAdapter(pending.provider);
      if (!adapter) {
        return res.status(400).json({error: 'Unsupported provider', mode});
      }

      let profile;
      try {
        profile = await adapter.exchangeCode({
          code: code.toString(),
          redirectUri: oauthCallbackRedirectUri(),
        });
      } catch (error) {
        if (isOAuthEmailRequiredError(error)) {
          return res.status(400).json({
            message: error.message,
            code: error.code,
            mode,
          });
        }
        throw error;
      }
      if (!profile) {
        return res
          .status(400)
          .json({message: 'Failed to exchange code for tokens', mode});
      }

      if (pending.mode === 'reauth') {
        const stepUpScope = pending.scope && isStepUpScope(pending.scope)
          ? pending.scope
          : 'email-change';
        const linked = await OAuthProvider.findOne({
          where: {
            userId: req.user!.id,
            provider: profile.provider,
            providerId: profile.id,
          },
        });
        if (!linked) {
          return res.status(403).json({
            message: 'OAuth account does not match a linked provider on this account',
            code: 'OAUTH_REAUTH_MISMATCH',
            mode,
          });
        }
        await stepUpGrantService.grantAfterOAuthReauth(req.user!.id, res, stepUpScope, {
          ip: parseClientIp(req),
          userAgent: req.get('user-agent') ?? undefined,
        });
        return res.json({success: true, stepUp: true, scope: stepUpScope, mode});
      }

      if (pending.mode === 'linking') {
        try {
          await OAuthService.linkProvider(req.user!.id, {
            id: profile.id,
            provider: profile.provider,
            username: profile.username,
            email: profile.email || undefined,
          });
          await CacheInvalidation.invalidateUser(req.user!.id);
          return res.json({success: true, mode});
        } catch (error: unknown) {
          const err = error as {message?: string; response?: {status?: number}};
          if (
            (err.message && err.message.includes('ERR_BAD_REQUEST')) ||
            err.response?.status === 400
          ) {
            return res.status(400).json({error: 'Invalid code', mode});
          }
          logger.error('Provider linking error:', error);
          return res.status(400).json({
            error: err.message || 'Failed to link provider',
            mode,
          });
        }
      }

      const [user, isNew] = await OAuthService.findOrCreateUser({
        id: profile.id,
        provider: profile.provider,
        username: profile.username,
        email: profile.email || undefined,
      });

      await CacheInvalidation.invalidateUser(user.id);

      const auth = await sessionIssuanceService.completeAuthentication(user, req, res, {
        mfaExempt: true,
      });
      if (auth.status !== 'session') {
        return res.status(500).json({message: 'Authentication failed', mode});
      }
      if (!isNew) {
        securityNotificationService.notify(user.id, 'new-signin', {
          req,
          method: profile.provider,
        });
      }
      return res.json({
        user: auth.user,
        isNew,
        expiresIn: auth.expiresIn,
        sessionId: auth.sessionId,
        mode,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('400')) {
        return res.status(400).json({message: 'Bad authentication code', mode});
      }
      logger.error('OAuth callback error:', error);
      return res.status(500).json({message: 'Authentication failed', mode});
    }
  },

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

      await CacheInvalidation.invalidateUser(req.user!.id);

      return res.json({success});
    } catch (error) {
      logger.error('Provider unlinking error:', error);
      return res.status(500).json({error: 'Failed to unlink provider'});
    }
  },
};
