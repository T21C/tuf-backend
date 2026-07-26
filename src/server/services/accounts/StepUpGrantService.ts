import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { passwordUtils } from '@/misc/utils/auth/auth.js';
import { AUTH_COOKIE_OPTIONS } from '@/misc/utils/auth/auth.js';
import { accountCredentialService } from '@/server/services/accounts/AccountCredentialService.js';
import User from '@/models/auth/User.js';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const STEP_UP_COOKIE = 'stepUpGrant';
const STEP_UP_TTL_SEC = 10 * 60; // 10 minutes

export type StepUpScope = 'email-change';

interface StepUpPayload {
  sub: string;
  scope: StepUpScope;
  typ: 'step_up';
}

const isSecureAuthCookie = process.env.NODE_ENV !== 'development';

const STEP_UP_COOKIE_OPTIONS = {
  ...AUTH_COOKIE_OPTIONS,
  maxAge: STEP_UP_TTL_SEC * 1000,
};

class StepUpGrantService {
  cookieName = STEP_UP_COOKIE;

  issueGrant(res: Response, userId: string, scope: StepUpScope = 'email-change'): void {
    const token = jwt.sign(
      { sub: userId, scope, typ: 'step_up' } satisfies StepUpPayload,
      JWT_SECRET,
      { expiresIn: STEP_UP_TTL_SEC },
    );
    res.cookie(STEP_UP_COOKIE, token, STEP_UP_COOKIE_OPTIONS);
  }

  clearGrant(res: Response): void {
    res.clearCookie(STEP_UP_COOKIE, STEP_UP_COOKIE_OPTIONS);
  }

  readGrant(req: Request, scope: StepUpScope = 'email-change'): StepUpPayload | null {
    const raw = req.cookies?.[STEP_UP_COOKIE];
    if (!raw || typeof raw !== 'string') return null;
    try {
      const decoded = jwt.verify(raw, JWT_SECRET) as StepUpPayload;
      if (decoded.typ !== 'step_up' || decoded.scope !== scope) return null;
      if (!decoded.sub) return null;
      return decoded;
    } catch {
      return null;
    }
  }

  /**
   * Middleware: require a valid step-up grant matching the authenticated user.
   */
  requireStepUp(scope: StepUpScope = 'email-change') {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (!req.user?.id) {
        res.status(401).json({ message: 'User not authenticated' });
        return;
      }
      const grant = this.readGrant(req, scope);
      if (!grant || grant.sub !== req.user.id) {
        res.status(403).json({
          message: 'Recent authentication required',
          code: 'STEP_UP_REQUIRED',
        });
        return;
      }
      next();
    };
  }

  async grantWithPassword(
    userId: string,
    password: string,
    res: Response,
    ctx?: { ip?: string | null; userAgent?: string | null },
  ): Promise<void> {
    const user = await User.findByPk(userId);
    if (!user) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }
    if (!user.password) {
      throw Object.assign(
        new Error('Account has no password. Re-authenticate with a linked provider.'),
        { statusCode: 400, code: 'OAUTH_REAUTH_REQUIRED' },
      );
    }
    const ok = await passwordUtils.comparePassword(password, user.password);
    if (!ok) {
      throw Object.assign(new Error('Incorrect password'), { statusCode: 400 });
    }
    this.issueGrant(res, userId, 'email-change');
    await accountCredentialService.logAction(userId, 'step_up_granted', { method: 'password' }, ctx);
  }

  /**
   * Issue step-up after successful Discord (or other) reauth for OAuth-only accounts.
   */
  async grantAfterOAuthReauth(
    userId: string,
    res: Response,
    ctx?: { ip?: string | null; userAgent?: string | null },
  ): Promise<void> {
    this.issueGrant(res, userId, 'email-change');
    await accountCredentialService.logAction(userId, 'step_up_granted', { method: 'oauth' }, ctx);
  }

  /** Generate a CSRF double-submit token value. */
  generateCsrfToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  setCsrfCookie(res: Response, token?: string): string {
    const value = token || this.generateCsrfToken();
    res.cookie('csrfToken', value, {
      httpOnly: false,
      secure: isSecureAuthCookie,
      sameSite: isSecureAuthCookie ? 'none' : 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    return value;
  }

  clearCsrfCookie(res: Response): void {
    res.clearCookie('csrfToken', {
      httpOnly: false,
      secure: isSecureAuthCookie,
      sameSite: isSecureAuthCookie ? 'none' : 'lax',
      path: '/',
    });
  }
}

export const stepUpGrantService = new StepUpGrantService();
