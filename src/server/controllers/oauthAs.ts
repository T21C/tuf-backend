import { Request, Response } from 'express';
import { ownUrl, clientUrlEnv } from '@/config/app.config.js';
import {
  OAUTH_CONSENT_PENDING_COOKIE,
  OAUTH_CONSENT_PENDING_TTL_SEC,
} from '@/config/oauth.config.js';
import {
  V1_GRANTABLE_SCOPE_NAMES,
  parseScopeBitsStored,
  scopeBitsToNames,
  hasOAuthScope,
  oauthScopeFlags,
} from '@/config/oauthScopes.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { oauthClientService } from '@/server/services/oauth/OAuthClientService.js';
import {
  OAuthAsError,
  buildUserResource,
  exchangeAuthorizationCode,
  grantNeedsConsent,
  issueAuthorizationCode,
  refreshAccessToken,
  revokeToken,
  signConsentPending,
  validateAuthorizeAgainstClient,
  validateAuthorizeQuery,
  verifyConsentPending,
} from '@/server/services/oauth/OAuthTokenService.js';
import User from '@/models/auth/User.js';

function cookieOpts() {
  const secure =
    process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging';
  return {
    httpOnly: true,
    secure,
    sameSite: (secure ? 'none' : 'lax') as 'none' | 'lax',
    maxAge: OAUTH_CONSENT_PENDING_TTL_SEC * 1000,
    path: '/',
  };
}

function redirectWithError(
  res: Response,
  redirectUri: string | null,
  safe: boolean,
  error: string,
  description: string,
  state?: string,
) {
  if (safe && redirectUri) {
    const u = new URL(redirectUri);
    u.searchParams.set('error', error);
    u.searchParams.set('error_description', description);
    if (state) u.searchParams.set('state', state);
    return res.redirect(u.toString());
  }
  return res.status(400).json({ error, error_description: description });
}

export const oauthAsController = {
  wellKnown(_req: Request, res: Response) {
    const issuer = (ownUrl || '').replace(/\/$/, '');
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...V1_GRANTABLE_SCOPE_NAMES],
      revocation_endpoint_auth_methods_supported: ['none'],
    });
  },

  async authorize(req: Request, res: Response) {
    let redirectUri: string | null = null;
    let state: string | undefined;
    let safeToRedirect = false;
    try {
      const authReq = validateAuthorizeQuery(req.query as Record<string, unknown>);
      redirectUri = authReq.redirectUri;
      state = authReq.state;
      const { client, scopeBits } = await validateAuthorizeAgainstClient(authReq);
      safeToRedirect = true;

      const user = req.user as { id: string; playerId?: number } | undefined;
      if (!user?.id) {
        const returnTo = encodeURIComponent(
          `${(ownUrl || '').replace(/\/$/, '')}/oauth/authorize?${new URLSearchParams(
            req.query as Record<string, string>,
          ).toString()}`,
        );
        const loginUrl = `${(clientUrlEnv || '').replace(/\/$/, '')}/login?returnTo=${returnTo}`;
        return res.redirect(loginUrl);
      }

      const needsConsent = await grantNeedsConsent(user.id, client.clientId, scopeBits);
      if (!needsConsent) {
        const { code } = await issueAuthorizationCode({
          userId: user.id,
          client,
          redirectUri: authReq.redirectUri,
          scopeBits,
          codeChallenge: authReq.codeChallenge,
        });
        const u = new URL(authReq.redirectUri);
        u.searchParams.set('code', code);
        u.searchParams.set('state', authReq.state);
        return res.redirect(u.toString());
      }

      const pending = signConsentPending({
        clientId: client.clientId,
        redirectUri: authReq.redirectUri,
        scopeBits: scopeBits.toString(),
        state: authReq.state,
        codeChallenge: authReq.codeChallenge,
        userId: user.id,
      });
      res.cookie(OAUTH_CONSENT_PENDING_COOKIE, pending, cookieOpts());
      const consentUrl = `${(clientUrlEnv || '').replace(/\/$/, '')}/oauth/consent`;
      return res.redirect(consentUrl);
    } catch (err) {
      if (err instanceof OAuthAsError) {
        return redirectWithError(
          res,
          redirectUri,
          err.safeToRedirect && safeToRedirect,
          err.errorCode,
          err.message,
          state,
        );
      }
      logger.error('oauth_authorize_error', err);
      return res.status(500).json({ error: 'server_error' });
    }
  },

  async consentInfo(req: Request, res: Response) {
    try {
      const token = req.cookies?.[OAUTH_CONSENT_PENDING_COOKIE];
      if (!token) {
        return res.status(400).json({ error: 'No pending request' });
      }
      const pending = verifyConsentPending(token);
      if (!pending) {
        return res.status(400).json({ error: 'Request expired' });
      }
      if (!req.user || (req.user as { id: string }).id !== pending.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const client = await oauthClientService.findByClientId(pending.clientId);
      if (!client || client.status !== 'active') {
        return res.status(400).json({ error: 'Client unavailable' });
      }

      let ownerUsername: string | null = null;
      if (!client.verified) {
        const owner = await User.findByPk(client.ownerUserId, {
          attributes: ['username'],
        });
        ownerUsername = owner?.username ?? null;
      }

      const scopeBits = parseScopeBitsStored(pending.scopeBits);
      return res.json({
        client: {
          name: client.name,
          verified: client.verified,
          description: client.description,
          homepageUrl: client.homepageUrl,
          privacyUrl: client.privacyUrl,
          iconUrl: client.iconUrl ?? null,
          createdAt: client.createdAt,
          ownerUsername,
        },
        redirectUri: pending.redirectUri,
        scopeBits: scopeBits.toString(),
        scopes: scopeBitsToNames(scopeBits),
      });
    } catch (err) {
      logger.error('oauth_consent_info_error', err);
      return res.status(500).json({ error: 'server_error' });
    }
  },

  async consentApprove(req: Request, res: Response) {
    try {
      const token = req.cookies?.[OAUTH_CONSENT_PENDING_COOKIE];
      if (!token) {
        return res.status(400).json({ error: 'No pending request' });
      }
      const pending = verifyConsentPending(token);
      if (!pending) {
        return res.status(400).json({ error: 'Request expired' });
      }
      if (!req.user || (req.user as { id: string }).id !== pending.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const client = await oauthClientService.findActiveByClientId(pending.clientId);
      if (!client) {
        return res.status(400).json({ error: 'Client unavailable' });
      }

      const scopeBits = parseScopeBitsStored(pending.scopeBits);
      const { code } = await issueAuthorizationCode({
        userId: pending.userId,
        client,
        redirectUri: pending.redirectUri,
        scopeBits,
        codeChallenge: pending.codeChallenge,
      });

      res.clearCookie(OAUTH_CONSENT_PENDING_COOKIE, { path: '/' });
      const u = new URL(pending.redirectUri);
      u.searchParams.set('code', code);
      u.searchParams.set('state', pending.state);
      return res.json({ redirectTo: u.toString() });
    } catch (err) {
      if (err instanceof OAuthAsError) {
        return res.status(err.status).json({
          error: err.errorCode,
          error_description: err.message,
        });
      }
      logger.error('oauth_consent_approve_error', err);
      return res.status(500).json({ error: 'server_error' });
    }
  },

  async consentDeny(req: Request, res: Response) {
    try {
      const token = req.cookies?.[OAUTH_CONSENT_PENDING_COOKIE];
      const pending = token ? verifyConsentPending(token) : null;
      res.clearCookie(OAUTH_CONSENT_PENDING_COOKIE, { path: '/' });
      if (pending) {
        const u = new URL(pending.redirectUri);
        u.searchParams.set('error', 'access_denied');
        u.searchParams.set('error_description', 'User denied consent');
        u.searchParams.set('state', pending.state);
        return res.json({ redirectTo: u.toString() });
      }
      return res.json({ redirectTo: (clientUrlEnv || '/').replace(/\/$/, '') });
    } catch (err) {
      logger.error('oauth_consent_deny_error', err);
      return res.status(500).json({ error: 'server_error' });
    }
  },

  async token(req: Request, res: Response) {
    try {
      const body = req.body ?? {};
      const grantType = String(body.grant_type ?? '');
      const clientId = String(body.client_id ?? '');
      const ua = req.get('user-agent') || undefined;
      const ip = req.ip;

      if (grantType === 'authorization_code') {
        const result = await exchangeAuthorizationCode({
          code: String(body.code ?? ''),
          clientId,
          redirectUri: String(body.redirect_uri ?? ''),
          codeVerifier: String(body.code_verifier ?? ''),
          userAgent: ua,
          ip,
        });
        return res.json(result);
      }

      if (grantType === 'refresh_token') {
        const result = await refreshAccessToken({
          refreshToken: String(body.refresh_token ?? ''),
          clientId,
          userAgent: ua,
          ip,
        });
        return res.json(result);
      }

      return res.status(400).json({
        error: 'unsupported_grant_type',
        error_description: 'Only authorization_code and refresh_token are supported',
      });
    } catch (err) {
      if (err instanceof OAuthAsError) {
        return res.status(err.status).json({
          error: err.errorCode,
          error_description: err.message,
        });
      }
      logger.error('oauth_token_error', err);
      return res.status(500).json({ error: 'server_error' });
    }
  },

  async revoke(req: Request, res: Response) {
    try {
      const token = String(req.body?.token ?? '');
      const clientId = req.body?.client_id ? String(req.body.client_id) : undefined;
      if (!token) {
        return res.status(400).json({ error: 'invalid_request' });
      }
      await revokeToken({ token, clientId });
      return res.status(200).json({ revoked: true });
    } catch (err) {
      logger.error('oauth_revoke_error', err);
      return res.status(200).json({ revoked: true });
    }
  },

  async resourceUser(req: Request, res: Response) {
    try {
      const oauth = req.oauth;
      if (!oauth) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      if (!hasOAuthScope(oauth.scopeBits, oauthScopeFlags.USER_READ_PUBLIC)) {
        return res.status(403).json({ error: 'insufficient_scope' });
      }
      const dto = await buildUserResource(oauth.userId, oauth.scopeBits);
      if (!dto) {
        return res.status(404).json({ error: 'not_found' });
      }
      return res.json(dto);
    } catch (err) {
      logger.error('oauth_resource_user_error', err);
      return res.status(500).json({ error: 'server_error' });
    }
  },
};
