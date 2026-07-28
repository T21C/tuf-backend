import { Request, Response } from 'express';
import { CreationAttributes } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';
import User from '@/models/auth/User.js';
import Player from '@/models/players/Player.js';
import {
  passwordUtils,
  tokenUtils,
  refreshTokenService,
  cookieUtils,
  ACCESS_COOKIE_MAX_AGE_SEC,
  REFRESH_COOKIE_MAX_AGE_SEC,
} from '@/misc/utils/auth/auth.js';
import { logger } from '@/server/services/core/LoggerService.js';
import CaptchaService from '@/server/services/accounts/CaptchaService.js';
import { RateLimiter } from '@/server/decorators/rateLimiter.js';
import { permissionFlags } from '@/config/constants.js';
import { hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import { getUsernameFormatError, normalizeUsername } from '@/misc/utils/auth/username.js';
import {
  accountCredentialService,
  CredentialError,
} from '@/server/services/accounts/AccountCredentialService.js';
import { stepUpGrantService } from '@/server/services/accounts/StepUpGrantService.js';
import { parseClientIp } from '@/misc/utils/auth/rateLimitSubjects.js';

const captchaService = new CaptchaService();

const failedAttempts = new Map<string, { count: number; timestamp: number }>();
const ATTEMPT_TIMEOUT = 30 * 60 * 1000;

const isCaptchaRequired = (ip: string): boolean => {
  const attempts = failedAttempts.get(ip);
  if (!attempts) return false;
  if (Date.now() - attempts.timestamp > ATTEMPT_TIMEOUT) {
    failedAttempts.delete(ip);
    return false;
  }
  return attempts.count >= 1;
};

const recordFailedAttempt = (identifier: string): void => {
  const attempts = failedAttempts.get(identifier) || { count: 0, timestamp: Date.now() };
  attempts.count += 1;
  attempts.timestamp = Date.now();
  failedAttempts.set(identifier, attempts);
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

function publicUserFields(user: User) {
  return {
    id: user.id,
    username: user.username,
    email: user.email ?? null,
    pendingEmail: user.pendingEmail ?? null,
    emailResendAvailableAt: accountCredentialService.getEmailResendAvailableAt(user)?.toISOString() ?? null,
    isRater: hasFlag(user, permissionFlags.RATER),
    isSuperAdmin: hasFlag(user, permissionFlags.SUPER_ADMIN),
    isEmailVerified: hasFlag(user, permissionFlags.EMAIL_VERIFIED),
    permissionFlags: user.permissionFlags.toString(),
  };
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

      return res.status(201).json({
        message: 'Registration successful. Please check your email for verification.',
        user: publicUserFields(user),
        expiresIn: ACCESS_COOKIE_MAX_AGE_SEC,
        sessionId,
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
      const { password } = req.body || {};
      if (!password || typeof password !== 'string') {
        return res.status(400).json({
          message: 'Password is required, or complete OAuth re-authentication',
          code: 'PASSWORD_OR_OAUTH_REQUIRED',
        });
      }
      await stepUpGrantService.grantWithPassword(userId, password, res, actionCtx(req));
      return res.json({
        message: 'Step-up granted',
        expiresIn: 10 * 60,
        scope: 'email-change',
      });
    } catch (error) {
      return mapCredentialError(error, res, 'Step-up failed');
    }
  }

  @RateLimiter({
    windowMs: 60 * 60 * 1000,
    maxAttempts: 25,
    blockDuration: 10 * 60 * 1000,
    type: 'login',
    incrementOnFailure: true,
  })
  public async login(req: Request, res: Response): Promise<Response> {
    try {
      const { emailOrUsername, password, captchaToken } = req.body;
      const ip = parseClientIp(req);

      if (!emailOrUsername || !password) {
        return res.status(400).json({ message: 'Email/Username and password are required' });
      }

      const captchaRequired = isCaptchaRequired(ip);
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
          recordFailedAttempt(ip);
          return res.status(400).json({
            error: 'Invalid captcha or high risk score detected',
            requireCaptcha: true,
            message: 'Captcha verification failed. Please try again.',
          });
        }
      }

      const user = await accountCredentialService.findUserByLoginIdentifier(emailOrUsername);

      if (!user) {
        recordFailedAttempt(ip);
        return res.status(401).json({
          message: 'Invalid credentials',
          requireCaptcha: isCaptchaRequired(ip),
        });
      }

      if (!user.password) {
        return res
          .status(400)
          .json({ message: 'Account not linked to a password. Please use OAuth to login.' });
      }

      const passwordCheck = await passwordUtils.verifyAndMaybeRehash(password, user.password);
      if (!passwordCheck.ok) {
        recordFailedAttempt(ip);
        return res.status(401).json({
          message: 'Invalid credentials',
          requireCaptcha: isCaptchaRequired(ip),
        });
      }

      failedAttempts.delete(ip);
      await user.update({
        lastLogin: new Date(),
        ...(passwordCheck.newHash ? { password: passwordCheck.newHash } : {}),
      });

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

      return res.json({
        user: publicUserFields(user),
        expiresIn: ACCESS_COOKIE_MAX_AGE_SEC,
        sessionId,
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
      const captchaRequired = isCaptchaRequired(ip);
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
    type: 'email-verify-attempt',
    incrementOnFailure: true,
    incrementOnSuccess: true,
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
      const accessToken = tokenUtils.generateAccessToken(rotated.user, rotated.sessionId);
      cookieUtils.setAuthCookies(
        res,
        accessToken,
        rotated.token,
        ACCESS_COOKIE_MAX_AGE_SEC,
        REFRESH_COOKIE_MAX_AGE_SEC,
      );
      return res.json({
        user: publicUserFields(rotated.user),
        expiresIn: ACCESS_COOKIE_MAX_AGE_SEC,
        sessionId: rotated.sessionId,
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
}

export const authController = new AuthController();
