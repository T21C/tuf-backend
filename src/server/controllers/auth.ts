import { Request, Response } from 'express';
import { CreationAttributes } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';
import User from '@/models/auth/User.js';
import Player from '@/models/players/Player.js';
import {
  passwordUtils,
  refreshTokenService,
  cookieUtils,
} from '@/misc/utils/auth/auth.js';
import { logger } from '@/server/services/core/LoggerService.js';
import CaptchaService from '@/server/services/accounts/CaptchaService.js';
import { RateLimiter } from '@/server/decorators/rateLimiter.js';
import { getUsernameFormatError, normalizeUsername } from '@/misc/utils/auth/username.js';
import {
  accountCredentialService,
  CredentialError,
} from '@/server/services/accounts/AccountCredentialService.js';
import {
  stepUpGrantService,
  isStepUpScope,
  type StepUpScope,
} from '@/server/services/auth/StepUpGrantService.js';
import { sessionIssuanceService } from '@/server/services/auth/SessionIssuanceService.js';
import { trustedDeviceService } from '@/server/services/auth/TrustedDeviceService.js';
import { publicUserFields } from '@/server/services/auth/userSerializer.js';
import {
  parseClientIp,
  rateLimitSubjectAccount,
} from '@/misc/utils/auth/rateLimitSubjects.js';
import { STEP_UP_TTL_SEC } from '@/config/auth.config.js';
import { securityNotificationService } from '@/server/services/accounts/SecurityNotificationService.js';

const captchaService = new CaptchaService();

const failedAttempts = new Map<string, { count: number; timestamp: number }>();
const ATTEMPT_TIMEOUT = 30 * 60 * 1000;

const authenticationAttemptKeys = (ip: string, identifier: unknown): string[] => {
  const accountKey = rateLimitSubjectAccount(identifier);
  return accountKey ? [ip, accountKey] : [ip];
};

const isCaptchaRequired = (keys: string[]): boolean => {
  return keys.some(key => {
    const attempts = failedAttempts.get(key);
    if (!attempts) return false;
    if (Date.now() - attempts.timestamp > ATTEMPT_TIMEOUT) {
      failedAttempts.delete(key);
      return false;
    }
    return attempts.count >= 1;
  });
};

const recordFailedAttempt = (keys: string[]): void => {
  for (const key of keys) {
    const attempts = failedAttempts.get(key) || { count: 0, timestamp: Date.now() };
    attempts.count += 1;
    attempts.timestamp = Date.now();
    failedAttempts.set(key, attempts);
  }
};

function actionCtx(req: Request) {
  return {
    ip: parseClientIp(req),
    userAgent: req.get('user-agent') ?? undefined,
  };
}

function mapCredentialError(error: unknown, res: Response, fallback: string): Response {
  if (error instanceof CredentialError) {
    return res.status(error.statusCode).json({
      message: error.message,
      code: error.code,
      ...(error.details?.retryAfter != null ? { retryAfter: error.details.retryAfter } : {}),
      ...(error.details?.maskedEmail ? { maskedEmail: error.details.maskedEmail } : {}),
    });
  }
  const statusCode = (error as { statusCode?: number })?.statusCode;
  if (statusCode) {
    return res.status(statusCode).json({
      message: error instanceof Error ? error.message : fallback,
      code: (error as { code?: string }).code,
    });
  }
  logger.error(fallback, error);
  return res.status(500).json({ message: fallback });
}

class AuthController {
  @RateLimiter({
    windowMs: 24 * 60 * 60 * 1000,
    maxAttempts: 5,
    blockDuration: 8 * 60 * 60 * 1000,
    type: 'registration',
    incrementOnFailure: false,
    incrementOnSuccess: true,
  })
  public async register(req: Request, res: Response): Promise<Response> {
    try {
      const { email, password, captchaToken } = req.body;
      const username = normalizeUsername(String(req.body.username ?? ''));

      if (!captchaToken) {
        return res.status(400).json({ message: 'Captcha is required' });
      }
      const isValidCaptcha = await captchaService.verifyCaptcha(captchaToken);
      if (!isValidCaptcha) {
        return res.status(400).json({ message: 'Invalid captcha' });
      }

      if (!email || !password || !username) {
        return res.status(400).json({ message: 'All fields are required' });
      }

      try {
        accountCredentialService.assertValidEmail(accountCredentialService.normalizeEmail(email));
      } catch {
        return res.status(400).json({ message: 'Invalid email format' });
      }

      const usernameFormatError = getUsernameFormatError(username);
      if (usernameFormatError) {
        return res.status(400).json({ message: usernameFormatError });
      }

      if (password.length < 8) {
        return res.status(400).json({ message: 'Password must be at least 8 characters long' });
      }

      try {
        await accountCredentialService.assertEmailAvailable(
          accountCredentialService.normalizeEmail(email),
        );
      } catch {
        return res.status(400).json({ message: 'Registration failed' });
      }

      const existingUsername = await User.findOne({ where: { username } });
      if (existingUsername) {
        return res.status(400).json({ message: 'Username already taken' });
      }

      let finalUsername = username;
      let usernameExists = true;
      let attempts = 0;
      const maxAttempts = 10;

      while (usernameExists && attempts < maxAttempts) {
        const existingPlayer = await Player.findOne({ where: { name: finalUsername } });
        if (!existingPlayer) {
          usernameExists = false;
        } else {
          const randomNum = Math.floor(Math.random() * 999999) + 1;
          finalUsername = `${username}_${randomNum}`;
          attempts++;
        }
      }

      if (usernameExists) {
        return res
          .status(400)
          .json({ message: 'Could not generate a unique username. Please try a different username.' });
      }

      const hashedPassword = await passwordUtils.hashPassword(password);
      const player = await Player.create({
        name: finalUsername,
        country: 'XX',
        isBanned: false,
        isSubmissionsPaused: false,
      });

      const now = new Date();
      const userData: CreationAttributes<User> = {
        id: uuidv4(),
        email: null,
        pendingEmail: null,
        username,
        password: hashedPassword,
        isEmailVerified: false,
        isRater: false,
        isSuperAdmin: false,
        isRatingBanned: false,
        status: 'active',
        lastLogin: now,
        updatedAt: now,
        createdAt: now,
        permissionVersion: 1,
        playerId: player.id,
        permissionFlags: 0,
      };

      const user = await User.create(userData);
      await accountCredentialService.claimEmailOnRegister(user, email, actionCtx(req));
      await user.reload();

      const auth = await sessionIssuanceService.completeAuthentication(user, req, res);
      if (auth.status !== 'session') {
        return res.status(500).json({ message: 'Registration failed' });
      }

      return res.status(201).json({
        message: 'Registration successful. Please check your email for verification.',
        user: auth.user,
        expiresIn: auth.expiresIn,
        sessionId: auth.sessionId,
        usernameModified: finalUsername !== username,
      });
    } catch (error) {
      if (error instanceof CredentialError) {
        return res.status(error.statusCode).json({ message: 'Registration failed' });
      }
      logger.error('Registration error:', error);
      return res.status(500).json({ message: 'Registration failed' });
    }
  }

  @RateLimiter({
    windowMs: 15 * 60 * 1000,
    maxAttempts: 10,
    blockDuration: 15 * 60 * 1000,
    type: 'email-verify-attempt',
    incrementOnFailure: true,
    incrementOnSuccess: true,
    subjects: ['ip', 'user'],
  })
  public async verifyEmail(req: Request, res: Response): Promise<Response> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ message: 'User not authenticated' });
      }
      const { code } = req.body;
      if (!code || typeof code !== 'string') {
        return res.status(400).json({ message: 'Verification code is required' });
      }

      const { email } = await accountCredentialService.confirmEmailCode(
        userId,
        code,
        actionCtx(req),
      );

      stepUpGrantService.clearGrant(res);
      cookieUtils.clearAuthCookies(res);

      return res.json({
        message: 'Email verified successfully',
        email,
        requireLogin: true,
      });
    } catch (error) {
      return mapCredentialError(error, res, 'Email verification failed');
    }
  }

  @RateLimiter({
    windowMs: 60 * 60 * 1000,
    maxAttempts: 5,
    blockDuration: 30 * 60 * 1000,
    type: 'email-verification',
    incrementOnSuccess: true,
    incrementOnFailure: false,
    subjects: ['ip', 'user'],
  })
  public async resendVerification(req: Request, res: Response): Promise<Response> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ message: 'User not authenticated' });
      }
      const result = await accountCredentialService.resendEmailCode(userId, actionCtx(req));
      return res.json({
        message: 'Verification email sent',
        pendingEmail: result.pendingEmail,
        emailResendAvailableAt: result.emailResendAvailableAt,
      });
    } catch (error) {
      return mapCredentialError(error, res, 'Failed to resend verification email');
    }
  }

  @RateLimiter({
    windowMs: 60 * 60 * 1000,
    maxAttempts: 5,
    blockDuration: 30 * 60 * 1000,
    type: 'email-verification',
    incrementOnFailure: true,
    incrementOnSuccess: true,
    subjects: ['ip', 'user'],
  })
  public async changeEmail(req: Request, res: Response): Promise<Response> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ message: 'User not authenticated' });
      }
      const nextEmail = req.body?.email;
      const result = await accountCredentialService.requestEmailChange(
        userId,
        nextEmail,
        actionCtx(req),
      );
      const user = await User.findByPk(userId);
      return res.status(200).json({
        message: 'Verification code sent. Confirm the new email to finish the change.',
        pendingEmail: result.pendingEmail,
        emailResendAvailableAt: result.emailResendAvailableAt,
        user: user ? publicUserFields(user) : undefined,
      });
    } catch (error) {
      if (error instanceof CredentialError && error.code === 'EMAIL_UNAVAILABLE') {
        return res.status(400).json({ message: 'Unable to update email' });
      }
      return mapCredentialError(error, res, 'Failed to change email');
    }
  }

  public async cancelPendingEmail(req: Request, res: Response): Promise<Response> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ message: 'User not authenticated' });
      }
      await accountCredentialService.cancelPendingEmail(userId, actionCtx(req));
      const user = await User.findByPk(userId);
      return res.json({
        message: 'Pending email change cancelled',
        user: user ? publicUserFields(user) : undefined,
      });
    } catch (error) {
      return mapCredentialError(error, res, 'Failed to cancel pending email');
    }
  }

  @RateLimiter({
    windowMs: 15 * 60 * 1000,
    maxAttempts: 10,
    blockDuration: 15 * 60 * 1000,
    type: 'step-up',
    incrementOnFailure: true,
    incrementOnSuccess: true,
    subjects: ['ip', 'user'],
  })
  public async stepUp(req: Request, res: Response): Promise<Response> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ message: 'User not authenticated' });
      }
      const { password, code, scope: rawScope } = req.body || {};
      let scope: StepUpScope = 'email-change';
      if (rawScope != null && rawScope !== '') {
        if (!isStepUpScope(rawScope)) {
          return res.status(400).json({
            message: 'Invalid step-up scope',
            code: 'INVALID_STEP_UP_SCOPE',
          });
        }
        scope = rawScope;
      }

      if (typeof code === 'string' && code.trim()) {
        await accountCredentialService.confirmStepUpCode(
          userId,
          scope,
          code,
          actionCtx(req),
        );
        await stepUpGrantService.grantAfterEmailCode(userId, res, scope, actionCtx(req));
        return res.json({
          message: 'Step-up granted',
          expiresIn: STEP_UP_TTL_SEC,
          scope,
          method: 'email_code',
        });
      }

      if (!password || typeof password !== 'string') {
        return res.status(400).json({
          message:
            'Confirmation code is required (or password / OAuth when adding a first email)',
          code: 'CODE_OR_PASSWORD_REQUIRED',
        });
      }
      await stepUpGrantService.grantWithPassword(userId, password, res, scope, actionCtx(req));
      return res.json({
        message: 'Step-up granted',
        expiresIn: STEP_UP_TTL_SEC,
        scope,
        method: 'password',
      });
    } catch (error) {
      return mapCredentialError(error, res, 'Step-up failed');
    }
  }

  @RateLimiter({
    windowMs: 15 * 60 * 1000,
    maxAttempts: 8,
    blockDuration: 15 * 60 * 1000,
    type: 'step-up-email',
    incrementOnFailure: true,
    incrementOnSuccess: true,
    subjects: ['ip', 'user'],
  })
  public async requestStepUpEmail(req: Request, res: Response): Promise<Response> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ message: 'User not authenticated' });
      }
      const { scope: rawScope } = req.body || {};
      let scope: StepUpScope = 'security';
      if (rawScope != null && rawScope !== '') {
        if (!isStepUpScope(rawScope)) {
          return res.status(400).json({
            message: 'Invalid step-up scope',
            code: 'INVALID_STEP_UP_SCOPE',
          });
        }
        scope = rawScope;
      }
      const result = await accountCredentialService.issueStepUpCode(
        userId,
        scope,
        actionCtx(req),
      );
      return res.json({
        message: 'Confirmation code sent',
        scope,
        maskedEmail: result.maskedEmail,
        emailResendAvailableAt: result.emailResendAvailableAt,
      });
    } catch (error) {
      return mapCredentialError(error, res, 'Failed to send confirmation code');
    }
  }

  @RateLimiter({
    windowMs: 60 * 60 * 1000,
    maxAttempts: 25,
    blockDuration: 10 * 60 * 1000,
    type: 'login',
    incrementOnFailure: true,
    accountIdentifier: req => req.body?.emailOrUsername,
    failClosed: true,
  })
  public async login(req: Request, res: Response): Promise<Response> {
    try {
      const { emailOrUsername, password, captchaToken } = req.body;
      const ip = parseClientIp(req);

      if (!emailOrUsername || !password) {
        return res.status(400).json({ message: 'Email/Username and password are required' });
      }

      const attemptKeys = authenticationAttemptKeys(ip, emailOrUsername);
      const captchaRequired = isCaptchaRequired(attemptKeys);
      if (captchaRequired) {
        if (!captchaToken) {
          return res.status(400).json({
            error: 'Captcha required',
            requireCaptcha: true,
            message: 'Please complete the captcha verification to continue',
          });
        }
        const isValidCaptcha = await captchaService.verifyCaptcha(captchaToken);
        if (!isValidCaptcha) {
          recordFailedAttempt(attemptKeys);
          return res.status(400).json({
            error: 'Invalid captcha or high risk score detected',
            requireCaptcha: true,
            message: 'Captcha verification failed. Please try again.',
          });
        }
      }

      const user = await accountCredentialService.findUserByLoginIdentifier(emailOrUsername);

      if (!user) {
        recordFailedAttempt(attemptKeys);
        return res.status(401).json({
          message: 'Invalid credentials',
          requireCaptcha: isCaptchaRequired(attemptKeys),
        });
      }

      if (!user.password) {
        return res
          .status(400)
          .json({ message: 'Account not linked to a password. Please use OAuth to login.' });
      }

      const passwordCheck = await passwordUtils.verifyAndMaybeRehash(password, user.password);
      if (!passwordCheck.ok) {
        recordFailedAttempt(attemptKeys);
        return res.status(401).json({
          message: 'Invalid credentials',
          requireCaptcha: isCaptchaRequired(attemptKeys),
        });
      }

      for (const key of attemptKeys) failedAttempts.delete(key);
      if (passwordCheck.newHash) {
        await user.update({ password: passwordCheck.newHash });
      }

      const auth = await sessionIssuanceService.completeAuthentication(user, req, res);

      if (auth.status === 'mfa_required') {
        // Cooldown from any still-outstanding login code, so the client resend
        // timer survives reloads / repeat phase-1 logins instead of 429ing.
        const emailResendAvailableAt =
          await accountCredentialService.getStepUpResendAvailableAt(user.id, 'login');
        return res.json({
          status: 'mfa_required',
          methods: auth.methods,
          maskedEmail: auth.maskedEmail,
          emailResendAvailableAt,
        });
      }

      await user.update({ lastLogin: new Date() });

      return res.json({
        status: 'session',
        user: auth.user,
        expiresIn: auth.expiresIn,
        sessionId: auth.sessionId,
      });
    } catch (error) {
      logger.error('Login error:', error);
      return res.status(500).json({ message: 'Login failed' });
    }
  }

  @RateLimiter({
    windowMs: 60 * 60 * 1000,
    maxAttempts: 3,
    blockDuration: 30 * 60 * 1000,
    type: 'password-reset',
    incrementOnFailure: false,
    incrementOnSuccess: true,
    accountIdentifier: req => req.body?.email,
    failClosed: true,
  })
  public async requestPasswordReset(req: Request, res: Response): Promise<Response> {
    const generic = {
      message: 'If an account with that email exists, a password reset code has been sent.',
    };
    try {
      const { email, captchaToken } = req.body;
      if (!email) {
        return res.status(400).json({ message: 'Email is required' });
      }

      const ip = parseClientIp(req);
      const attemptKeys = authenticationAttemptKeys(ip, email);
      const captchaRequired = isCaptchaRequired(attemptKeys);
      if (captchaRequired) {
        if (!captchaToken) {
          return res.status(400).json({
            error: 'Captcha required',
            requireCaptcha: true,
            message: 'Please complete the captcha verification to continue',
          });
        }
        const isValidCaptcha = await captchaService.verifyCaptcha(captchaToken);
        if (!isValidCaptcha) {
          recordFailedAttempt(attemptKeys);
          return res.status(400).json({
            error: 'Invalid captcha',
            requireCaptcha: true,
            message: 'Captcha verification failed. Please try again.',
          });
        }
      }

      try {
        await accountCredentialService.requestPasswordReset(email, actionCtx(req));
      } catch (error) {
        if (error instanceof CredentialError && error.statusCode === 500) {
          return res.status(500).json({ message: 'Failed to send password reset email' });
        }
        // Invalid format still returns generic to avoid enumeration on format? Plan says validate format.
        if (error instanceof CredentialError && error.code === 'INVALID_EMAIL') {
          return res.status(400).json({ message: 'Invalid email format' });
        }
      }

      return res.json(generic);
    } catch (error) {
      logger.error('Password reset request error:', error);
      return res.status(500).json({ message: 'Failed to process password reset request' });
    }
  }

  @RateLimiter({
    windowMs: 15 * 60 * 1000,
    maxAttempts: 10,
    blockDuration: 15 * 60 * 1000,
    type: 'password-reset-confirm',
    incrementOnFailure: true,
    incrementOnSuccess: true,
    accountIdentifier: req => req.body?.email,
    failClosed: true,
  })
  public async resetPassword(req: Request, res: Response): Promise<Response> {
    try {
      const { email, code, password, token } = req.body;
      // Accept legacy `token` field name as alias for code during transition
      const resetCode = code || token;
      const newPassword = password || req.body.newPassword;

      if (!email || !resetCode || !newPassword) {
        return res.status(400).json({ message: 'Email, code, and password are required' });
      }

      await accountCredentialService.confirmPasswordReset(
        email,
        resetCode,
        newPassword,
        actionCtx(req),
      );
      cookieUtils.clearAuthCookies(res);
      return res.json({ message: 'Password reset successfully', requireLogin: true });
    } catch (error) {
      return mapCredentialError(error, res, 'Failed to reset password');
    }
  }

  public async refresh(req: Request, res: Response): Promise<Response> {
    try {
      const refreshTokenValue = req.cookies?.refreshToken;
      if (!refreshTokenValue) {
        return res.status(401).json({ error: 'Refresh token required' });
      }
      const reqIp = parseClientIp(req);
      const rotated = await refreshTokenService.rotateRefreshToken(refreshTokenValue, {
        userAgent: req.get('user-agent'),
        ip: reqIp,
      });
      if (!rotated) {
        return res.status(401).json({ error: 'Invalid or expired refresh token' });
      }
      const auth = await sessionIssuanceService.reissueForSession(
        rotated.user,
        rotated.sessionId,
        rotated.token,
        res,
      );
      return res.json({
        user: auth.user,
        expiresIn: auth.expiresIn,
        sessionId: auth.sessionId,
      });
    } catch (error) {
      logger.error('Refresh token error:', error);
      return res.status(500).json({ error: 'Failed to refresh token' });
    }
  }

  public async logout(req: Request, res: Response): Promise<Response> {
    try {
      const refreshTokenValue = req.cookies?.refreshToken;
      if (refreshTokenValue) {
        await refreshTokenService.revokeRefreshToken(refreshTokenValue);
      }
      stepUpGrantService.clearGrant(res);
      cookieUtils.clearAuthCookies(res);
      return res.status(204).send();
    } catch (error) {
      logger.error('Logout error:', error);
      cookieUtils.clearAuthCookies(res);
      return res.status(204).send();
    }
  }

  public async getCsrf(req: Request, res: Response): Promise<Response> {
    const csrfToken = cookieUtils.ensureCsrfToken(req, res);
    return res.json({ csrfToken });
  }

  public async getSessions(req: Request, res: Response): Promise<Response> {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const currentRefreshToken = req.cookies?.refreshToken;
      const currentRecord = currentRefreshToken
        ? await refreshTokenService.findValidRefreshToken(currentRefreshToken)
        : null;
      const sessions = await refreshTokenService.listSessionsForUser(
        req.user.id,
        currentRecord?.id ?? null,
      );
      return res.json({ sessions });
    } catch (error) {
      logger.error('Get sessions error:', error);
      return res.status(500).json({ error: 'Failed to list sessions' });
    }
  }

  /**
   * Revoke all sessions except the current device (refresh cookie).
   */
  public async revokeOtherSessions(req: Request, res: Response): Promise<Response> {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const currentRefreshToken = req.cookies?.refreshToken;
      const currentRecord = currentRefreshToken
        ? await refreshTokenService.findValidRefreshToken(currentRefreshToken)
        : null;
      if (!currentRecord?.id) {
        return res.status(400).json({
          error: 'Current session required',
          code: 'CURRENT_SESSION_REQUIRED',
        });
      }
      const revokedCount = await refreshTokenService.revokeOtherSessionsForUser(
        req.user.id,
        currentRecord.id,
      );
      return res.json({ message: 'Other sessions revoked', revokedCount });
    } catch (error) {
      logger.error('Revoke other sessions error:', error);
      return res.status(500).json({ error: 'Failed to revoke other sessions' });
    }
  }

  public async revokeSession(req: Request, res: Response): Promise<Response> {
    try {
      const { id: sessionId } = req.params;
      if (!req.user?.id) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      if (!sessionId) {
        return res.status(400).json({ error: 'Session id required' });
      }
      const currentRefreshToken = req.cookies?.refreshToken;
      const currentRecord = currentRefreshToken
        ? await refreshTokenService.findValidRefreshToken(currentRefreshToken)
        : null;
      const revoked = await refreshTokenService.revokeSessionById(sessionId, req.user.id);
      if (!revoked) {
        return res.status(404).json({ error: 'Session not found or already revoked' });
      }
      if (currentRecord?.id === sessionId) {
        cookieUtils.clearAuthCookies(res);
      }
      return res.status(204).send();
    } catch (error) {
      logger.error('Revoke session error:', error);
      return res.status(500).json({ error: 'Failed to revoke session' });
    }
  }

  @RateLimiter({
    windowMs: 15 * 60 * 1000,
    maxAttempts: 8,
    blockDuration: 15 * 60 * 1000,
    type: 'mfa-email',
    incrementOnFailure: true,
    incrementOnSuccess: true,
  })
  public async requestLoginMfaEmail(req: Request, res: Response): Promise<Response> {
    try {
      const pending = sessionIssuanceService.readMfaPending(req);
      if (!pending) {
        return res.status(401).json({
          message: 'Login challenge expired. Please sign in again.',
          code: 'MFA_PENDING_REQUIRED',
        });
      }
      if (!pending.methods.includes('email')) {
        return res.status(400).json({
          message: 'Email MFA is not available for this login',
          code: 'MFA_METHOD_UNAVAILABLE',
        });
      }
      const result = await accountCredentialService.issueStepUpCode(
        pending.sub,
        'login',
        actionCtx(req),
      );
      return res.json({
        message: 'Login code sent',
        maskedEmail: result.maskedEmail,
        emailResendAvailableAt: result.emailResendAvailableAt,
      });
    } catch (error) {
      return mapCredentialError(error, res, 'Failed to send login code');
    }
  }

  @RateLimiter({
    windowMs: 15 * 60 * 1000,
    maxAttempts: 12,
    blockDuration: 15 * 60 * 1000,
    type: 'mfa-verify',
    incrementOnFailure: true,
  })
  public async verifyLoginMfa(req: Request, res: Response): Promise<Response> {
    try {
      const pending = sessionIssuanceService.readMfaPending(req);
      if (!pending) {
        return res.status(401).json({
          message: 'Login challenge expired. Please sign in again.',
          code: 'MFA_PENDING_REQUIRED',
        });
      }

      const { code, rememberDevice } = req.body || {};
      if (!code || typeof code !== 'string') {
        return res.status(400).json({
          message: 'Confirmation code is required',
          code: 'CODE_REQUIRED',
        });
      }
      if (!pending.methods.includes('email')) {
        return res.status(400).json({
          message: 'Email MFA is not available for this login',
          code: 'MFA_METHOD_UNAVAILABLE',
        });
      }

      await accountCredentialService.confirmStepUpCode(
        pending.sub,
        'login',
        code,
        actionCtx(req),
      );

      const user = await User.findByPk(pending.sub);
      if (!user) {
        sessionIssuanceService.clearMfaPending(res);
        return res.status(401).json({ message: 'User not found' });
      }

      if (rememberDevice === true) {
        await trustedDeviceService.trust(user.id, req, res);
      }

      const auth = await sessionIssuanceService.completeAuthentication(user, req, res, {
        mfaExempt: true,
      });
      if (auth.status !== 'session') {
        return res.status(500).json({ message: 'Login failed' });
      }

      await user.update({ lastLogin: new Date() });

      securityNotificationService.notify(user.id, 'new-signin', {
        req,
        remembered: rememberDevice === true,
        method: 'password',
      });

      return res.json({
        status: 'session',
        user: auth.user,
        expiresIn: auth.expiresIn,
        sessionId: auth.sessionId,
      });
    } catch (error) {
      return mapCredentialError(error, res, 'MFA verification failed');
    }
  }

  public async getTrustedDevices(req: Request, res: Response): Promise<Response> {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const currentId = await trustedDeviceService.currentDeviceId(req.user.id, req);
      const devices = await trustedDeviceService.listForUser(req.user.id, currentId);
      return res.json({ devices });
    } catch (error) {
      logger.error('Get trusted devices error:', error);
      return res.status(500).json({ error: 'Failed to list trusted devices' });
    }
  }

  public async revokeTrustedDevice(req: Request, res: Response): Promise<Response> {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const { id: deviceId } = req.params;
      if (!deviceId) {
        return res.status(400).json({ error: 'Device id required' });
      }
      const currentId = await trustedDeviceService.currentDeviceId(req.user.id, req);
      const revoked = await trustedDeviceService.revoke(deviceId, req.user.id);
      if (!revoked) {
        return res.status(404).json({ error: 'Trusted device not found or already revoked' });
      }
      if (currentId === deviceId) {
        trustedDeviceService.clearCookie(res);
      }
      return res.status(204).send();
    } catch (error) {
      logger.error('Revoke trusted device error:', error);
      return res.status(500).json({ error: 'Failed to revoke trusted device' });
    }
  }
}

export const authController = new AuthController();
