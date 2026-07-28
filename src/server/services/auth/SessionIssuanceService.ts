import jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';
import User from '@/models/auth/User.js';
import {
  tokenUtils,
  refreshTokenService,
  cookieUtils,
  ACCESS_COOKIE_MAX_AGE_SEC,
  REFRESH_COOKIE_MAX_AGE_SEC,
  AUTH_COOKIE_OPTIONS,
  cookieClearOptions,
} from '@/misc/utils/auth/auth.js';
import { parseClientIp } from '@/misc/utils/auth/rateLimitSubjects.js';
import { publicUserFields, type PublicUserFields } from './userSerializer.js';
import {
  accountCredentialService,
  hasVerifiedEmail,
} from '@/server/services/accounts/AccountCredentialService.js';
import { trustedDeviceService } from './TrustedDeviceService.js';
import {
  getAvailableMfaMethods,
  shouldChallengeMfa,
  type MfaMethod,
} from './mfaPolicy.js';
import {
  JWT_SECRET,
  MFA_PENDING_TTL_SEC,
  MFA_PENDING_COOKIE,
} from '@/config/auth.config.js';

const MFA_PENDING_COOKIE_PATH = '/v2/auth/mfa';

const MFA_PENDING_COOKIE_OPTIONS = {
  ...AUTH_COOKIE_OPTIONS,
  path: MFA_PENDING_COOKIE_PATH,
  maxAge: MFA_PENDING_TTL_SEC * 1000,
};

interface MfaPendingPayload {
  sub: string;
  methods: MfaMethod[];
  typ: 'mfa_pending';
}

/**
 * Result of completing authentication.
 * MFA gate returns mfa_required; callers must not treat that as a session.
 */
export type AuthCompletion =
  | {
      status: 'session';
      user: PublicUserFields;
      sessionId: string;
      expiresIn: number;
    }
  | {
      status: 'mfa_required';
      methods: MfaMethod[];
      maskedEmail: string;
    };

export type ReissueCompletion = Extract<AuthCompletion, { status: 'session' }>;

export interface CompleteAuthenticationOptions {
  /** Skip the MFA gate (OAuth login, post-MFA finalize). */
  mfaExempt?: boolean;
}

class SessionIssuanceService {
  /**
   * Mint a new refresh-token session and set auth cookies, or return an MFA
   * challenge when the account requires a second factor on this device.
   */
  async completeAuthentication(
    user: User,
    req: Request,
    res: Response,
    opts?: CompleteAuthenticationOptions,
  ): Promise<AuthCompletion> {
    const fullUser = (await User.findByPk(user.id)) ?? user;
    const methods = getAvailableMfaMethods(fullUser);
    const isTrusted =
      methods.length > 0
        ? await trustedDeviceService.isTrusted(fullUser.id, req)
        : false;

    if (
      shouldChallengeMfa({
        mfaExempt: Boolean(opts?.mfaExempt),
        isTrustedDevice: isTrusted,
        methods,
      })
    ) {
      return this.beginMfaChallenge(fullUser, res, methods);
    }

    return this.issueSession(fullUser, req, res);
  }

  /**
   * Re-issue access (+ rotated refresh) cookies for an existing session.
   * Skips the MFA gate — the caller already proved the refresh token.
   */
  async reissueForSession(
    user: User,
    sessionId: string,
    refreshToken: string,
    res: Response,
  ): Promise<ReissueCompletion> {
    const fullUser = (await User.findByPk(user.id)) ?? user;
    const accessToken = tokenUtils.generateAccessToken(fullUser, sessionId);
    cookieUtils.setAuthCookies(
      res,
      accessToken,
      refreshToken,
      ACCESS_COOKIE_MAX_AGE_SEC,
      REFRESH_COOKIE_MAX_AGE_SEC,
    );
    return {
      status: 'session',
      user: publicUserFields(fullUser),
      sessionId,
      expiresIn: ACCESS_COOKIE_MAX_AGE_SEC,
    };
  }

  beginMfaChallenge(
    user: User,
    res: Response,
    methods: MfaMethod[] = getAvailableMfaMethods(user),
  ): Extract<AuthCompletion, { status: 'mfa_required' }> {
    const token = jwt.sign(
      { sub: user.id, methods, typ: 'mfa_pending' } satisfies MfaPendingPayload,
      JWT_SECRET,
      { expiresIn: MFA_PENDING_TTL_SEC },
    );
    res.cookie(MFA_PENDING_COOKIE, token, MFA_PENDING_COOKIE_OPTIONS);

    const email =
      hasVerifiedEmail(user) && user.email
        ? accountCredentialService.maskEmail(user.email)
        : '';

    return {
      status: 'mfa_required',
      methods,
      maskedEmail: email,
    };
  }

  readMfaPending(req: Request): MfaPendingPayload | null {
    const raw = req.cookies?.[MFA_PENDING_COOKIE];
    if (!raw || typeof raw !== 'string') return null;
    try {
      const decoded = jwt.verify(raw, JWT_SECRET) as MfaPendingPayload;
      if (decoded.typ !== 'mfa_pending' || !decoded.sub) return null;
      if (!Array.isArray(decoded.methods) || decoded.methods.length === 0) return null;
      return decoded;
    } catch {
      return null;
    }
  }

  clearMfaPending(res: Response): void {
    res.clearCookie(MFA_PENDING_COOKIE, cookieClearOptions(MFA_PENDING_COOKIE_OPTIONS));
  }

  private async issueSession(
    user: User,
    req: Request,
    res: Response,
  ): Promise<ReissueCompletion> {
    this.clearMfaPending(res);
    const ip = parseClientIp(req);
    const { token: refreshToken, sessionId } = await refreshTokenService.createRefreshToken(
      user.id,
      { userAgent: req.get('user-agent'), ip },
    );
    const accessToken = tokenUtils.generateAccessToken(user, sessionId);
    cookieUtils.setAuthCookies(
      res,
      accessToken,
      refreshToken,
      ACCESS_COOKIE_MAX_AGE_SEC,
      REFRESH_COOKIE_MAX_AGE_SEC,
    );
    return {
      status: 'session',
      user: publicUserFields(user),
      sessionId,
      expiresIn: ACCESS_COOKIE_MAX_AGE_SEC,
    };
  }
}

export const sessionIssuanceService = new SessionIssuanceService();
