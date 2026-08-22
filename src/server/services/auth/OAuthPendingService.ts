import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';
import { AUTH_COOKIE_OPTIONS, cookieClearOptions } from '@/misc/utils/auth/auth.js';
import {
  JWT_SECRET,
  OAUTH_PENDING_COOKIE,
  OAUTH_PENDING_TTL_SEC,
} from '@/config/auth.config.js';
import type { StepUpScope } from '@/server/services/auth/StepUpGrantService.js';
import type { OAuthMode } from '@/server/services/accounts/oauthProviders/types.js';

const OAUTH_PENDING_COOKIE_PATH = '/v2/auth';

const OAUTH_PENDING_COOKIE_OPTIONS = {
  ...AUTH_COOKIE_OPTIONS,
  path: OAUTH_PENDING_COOKIE_PATH,
  maxAge: OAUTH_PENDING_TTL_SEC * 1000,
};

export interface OAuthPendingPayload {
  typ: 'oauth_pending';
  nonce: string;
  provider: string;
  mode: OAuthMode;
  sub?: string;
  scope?: StepUpScope;
}

function isOAuthMode(value: unknown): value is OAuthMode {
  return value === 'login' || value === 'linking' || value === 'reauth';
}

function generateNonce(): string {
  return crypto.randomBytes(32).toString('base64url');
}

class OAuthPendingService {
  cookieName = OAUTH_PENDING_COOKIE;

  issue(
    res: Response,
    args: {
      provider: string;
      mode: OAuthMode;
      userId?: string;
      scope?: StepUpScope;
    },
  ): string {
    const nonce = generateNonce();
    const payload: OAuthPendingPayload = {
      typ: 'oauth_pending',
      nonce,
      provider: args.provider,
      mode: args.mode,
      ...(args.userId ? { sub: args.userId } : {}),
      ...(args.scope ? { scope: args.scope } : {}),
    };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: OAUTH_PENDING_TTL_SEC });
    res.cookie(OAUTH_PENDING_COOKIE, token, OAUTH_PENDING_COOKIE_OPTIONS);
    return nonce;
  }

  read(req: Request): OAuthPendingPayload | null {
    const raw = req.cookies?.[OAUTH_PENDING_COOKIE];
    if (!raw || typeof raw !== 'string') return null;
    try {
      const decoded = jwt.verify(raw, JWT_SECRET) as OAuthPendingPayload;
      if (decoded.typ !== 'oauth_pending') return null;
      if (typeof decoded.nonce !== 'string' || decoded.nonce.length === 0) return null;
      if (typeof decoded.provider !== 'string' || decoded.provider.length === 0) return null;
      if (!isOAuthMode(decoded.mode)) return null;
      return decoded;
    } catch {
      return null;
    }
  }

  matchesState(pending: OAuthPendingPayload, state: unknown): boolean {
    return typeof state === 'string' && state.length > 0 && state === pending.nonce;
  }

  clear(res: Response): void {
    res.clearCookie(OAUTH_PENDING_COOKIE, cookieClearOptions(OAUTH_PENDING_COOKIE_OPTIONS));
  }
}

export const oauthPendingService = new OAuthPendingService();
