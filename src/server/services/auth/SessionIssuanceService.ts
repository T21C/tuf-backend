import type { Request, Response } from 'express';
import User from '@/models/auth/User.js';
import {
  tokenUtils,
  refreshTokenService,
  cookieUtils,
  ACCESS_COOKIE_MAX_AGE_SEC,
  REFRESH_COOKIE_MAX_AGE_SEC,
} from '@/misc/utils/auth/auth.js';
import { parseClientIp } from '@/misc/utils/auth/rateLimitSubjects.js';
import { publicUserFields, type PublicUserFields } from './userSerializer.js';

/**
 * Result of completing authentication.
 * Future MFA gate adds: `{ status: 'mfa_required'; methods: MfaMethod[] }`.
 */
export type AuthCompletion = {
  status: 'session';
  user: PublicUserFields;
  sessionId: string;
  expiresIn: number;
};

export type ReissueCompletion = AuthCompletion;

class SessionIssuanceService {
  /**
   * Mint a new refresh-token session and set auth cookies.
   * Controllers must call this for every fresh login (password, OAuth, register).
   * Future MFA gating belongs here so every path inherits it.
   */
  async completeAuthentication(
    user: User,
    req: Request,
    res: Response,
  ): Promise<AuthCompletion> {
    // Reload so password and OAuth callers share the same attribute set for serialization.
    const fullUser = (await User.findByPk(user.id)) ?? user;
    const ip = parseClientIp(req);
    const { token: refreshToken, sessionId } = await refreshTokenService.createRefreshToken(
      fullUser.id,
      { userAgent: req.get('user-agent'), ip },
    );
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

  /**
   * Re-issue access (+ rotated refresh) cookies for an existing session.
   * Skips any future MFA gate — the caller already proved the refresh token.
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
}

export const sessionIssuanceService = new SessionIssuanceService();
