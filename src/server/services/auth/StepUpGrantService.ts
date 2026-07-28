import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { passwordUtils, AUTH_COOKIE_OPTIONS, cookieClearOptions } from '@/misc/utils/auth/auth.js';
import {
  accountCredentialService,
  hasVerifiedEmail,
} from '@/server/services/accounts/AccountCredentialService.js';
import User from '@/models/auth/User.js';
import { JWT_SECRET, STEP_UP_TTL_SEC } from '@/config/auth.config.js';

const STEP_UP_COOKIE = 'stepUpGrant';

export const STEP_UP_SCOPES = ['email-change', 'security'] as const;
export type StepUpScope = (typeof STEP_UP_SCOPES)[number];

export function isStepUpScope(value: unknown): value is StepUpScope {
  return typeof value === 'string' && (STEP_UP_SCOPES as readonly string[]).includes(value);
}

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

  issueGrant(res: Response, userId: string, scope: StepUpScope): void {
    const token = jwt.sign(
      { sub: userId, scope, typ: 'step_up' } satisfies StepUpPayload,
      JWT_SECRET,
      { expiresIn: STEP_UP_TTL_SEC },
    );
    res.cookie(STEP_UP_COOKIE, token, STEP_UP_COOKIE_OPTIONS);
  }

  clearGrant(res: Response): void {
    res.clearCookie(STEP_UP_COOKIE, cookieClearOptions(STEP_UP_COOKIE_OPTIONS));
  }

  readGrant(req: Request, scope: StepUpScope): StepUpPayload | null {
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
   *
   * When the account has a verified email, only an emailed-code grant satisfies
   * this. When it does not, security-scoped actions are blocked with
   * EMAIL_REQUIRED; email-change stays reachable via password/OAuth grants so
   * the user can add a first email.
   */
  requireStepUp(scope: StepUpScope) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      if (!req.user?.id) {
        res.status(401).json({ message: 'User not authenticated' });
        return;
      }

      const user = await User.findByPk(req.user.id, {
        attributes: ['id', 'email', 'permissionFlags'],
      });
      if (!user) {
        res.status(401).json({ message: 'User not authenticated' });
        return;
      }

      if (!hasVerifiedEmail(user) && scope !== 'email-change') {
        res.status(403).json({
          message:
            'A verified email is required for this action. Add and verify an email first.',
          code: 'EMAIL_REQUIRED',
        });
        return;
      }

      const grant = this.readGrant(req, scope);
      if (!grant || grant.sub !== req.user.id) {
        res.status(403).json({
          message: 'Recent authentication required',
          code: 'STEP_UP_REQUIRED',
          requiresEmailCode: hasVerifiedEmail(user),
        });
        return;
      }
      next();
    };
  }

  /**
   * Password step-up is only allowed when the account has no verified email
   * (the add-first-email escape hatch). Verified accounts must use the emailed code.
   */
  async grantWithPassword(
    userId: string,
    password: string,
    res: Response,
    scope: StepUpScope,
    ctx?: { ip?: string | null; userAgent?: string | null },
  ): Promise<void> {
    const user = await User.findByPk(userId);
    if (!user) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }
    if (hasVerifiedEmail(user)) {
      throw Object.assign(
        new Error('Confirm with the code sent to your email'),
        { statusCode: 400, code: 'EMAIL_CODE_REQUIRED' },
      );
    }
    if (scope !== 'email-change') {
      throw Object.assign(
        new Error(
          'A verified email is required for this action. Add and verify an email first.',
        ),
        { statusCode: 403, code: 'EMAIL_REQUIRED' },
      );
    }
    if (!user.password) {
      throw Object.assign(
        new Error('Account has no password. Re-authenticate with a linked provider.'),
        { statusCode: 400, code: 'OAUTH_REAUTH_REQUIRED' },
      );
    }
    const passwordCheck = await passwordUtils.verifyAndMaybeRehash(password, user.password);
    if (!passwordCheck.ok) {
      throw Object.assign(new Error('Incorrect password'), { statusCode: 400 });
    }
    if (passwordCheck.newHash) {
      await user.update({ password: passwordCheck.newHash });
    }
    this.issueGrant(res, userId, scope);
    await accountCredentialService.logAction(
      userId,
      'step_up_granted',
      { method: 'password', scope },
      ctx,
    );
  }

  /**
   * OAuth reauth step-up — same restriction as grantWithPassword: only for
   * accounts that still need to add a first verified email.
   */
  async grantAfterOAuthReauth(
    userId: string,
    res: Response,
    scope: StepUpScope,
    ctx?: { ip?: string | null; userAgent?: string | null },
  ): Promise<void> {
    const user = await User.findByPk(userId, {
      attributes: ['id', 'email', 'permissionFlags'],
    });
    if (!user) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }
    if (hasVerifiedEmail(user)) {
      throw Object.assign(
        new Error('Confirm with the code sent to your email'),
        { statusCode: 400, code: 'EMAIL_CODE_REQUIRED' },
      );
    }
    if (scope !== 'email-change') {
      throw Object.assign(
        new Error(
          'A verified email is required for this action. Add and verify an email first.',
        ),
        { statusCode: 403, code: 'EMAIL_REQUIRED' },
      );
    }
    this.issueGrant(res, userId, scope);
    await accountCredentialService.logAction(
      userId,
      'step_up_granted',
      { method: 'oauth', scope },
      ctx,
    );
  }

  /**
   * Issue a grant after a successful emailed step-up code confirmation.
   */
  async grantAfterEmailCode(
    userId: string,
    res: Response,
    scope: StepUpScope,
    ctx?: { ip?: string | null; userAgent?: string | null },
  ): Promise<void> {
    this.issueGrant(res, userId, scope);
    await accountCredentialService.logAction(
      userId,
      'step_up_granted',
      { method: 'email_code', scope },
      ctx,
    );
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
