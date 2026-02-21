import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Op } from 'sequelize';
import type { Response } from 'express';
import {User, RefreshToken} from '../../../models/index.js';
import { hasFlag } from './permissionUtils.js';
import { permissionFlags } from '../../../config/constants.js';

const SALT_ROUNDS = 10;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key'; // Should be in env
/** @deprecated Use JWT_ACCESS_EXPIRES_IN and refresh tokens */
const JWT_EXPIRES_IN = 4 * 24 * 60 * 60; // 4 days in seconds (legacy)

const JWT_ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || '15m';
const JWT_REFRESH_EXPIRES_IN_DAYS = 7;
const JWT_REFRESH_EXPIRES_IN_SEC = JWT_REFRESH_EXPIRES_IN_DAYS * 24 * 60 * 60;

const COOKIE_ACCESS = 'accessToken';
const COOKIE_REFRESH = 'refreshToken';
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/',
};

/**
 * Password utilities
 */
export const passwordUtils = {
  /**
   * Hash a password using bcrypt
   */
  hashPassword: async (password: string): Promise<string> => {
    return bcrypt.hash(password, SALT_ROUNDS);
  },

  /**
   * Compare a password with a hash
   */
  comparePassword: async (password: string, hash: string): Promise<boolean> => {
    return bcrypt.compare(password, hash);
  },
};

function getAccessTokenPayload(user: User) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    isRater: hasFlag(user, permissionFlags.RATER),
    isSuperAdmin: hasFlag(user, permissionFlags.SUPER_ADMIN),
    permissionFlags: user.permissionFlags.toString(),
    playerId: user.playerId,
    permissionVersion: user.permissionVersion,
  };
}

/**
 * Token utilities
 */
export const tokenUtils = {
  /**
   * Generate short-lived access JWT for a user
   */
  generateAccessToken: (user: User): string => {
    const expiresInSec = 15 * 60;
    return jwt.sign(
      getAccessTokenPayload(user),
      JWT_SECRET,
      { expiresIn: expiresInSec }
    );
  },

  /**
   * Verify access JWT; returns decoded payload or null if invalid/expired
   */
  verifyAccessToken: (token: string): any => {
    try {
      return jwt.verify(token, JWT_SECRET);
    } catch {
      return null;
    }
  },

  /**
   * Generate a JWT token for a user (legacy; prefer generateAccessToken + refresh flow)
   */
  generateJWT: (user: User): string => {
    return tokenUtils.generateAccessToken(user);
  },

  /**
   * Verify a JWT token (legacy; prefer verifyAccessToken)
   */
  verifyJWT: (token: string): any => {
    return tokenUtils.verifyAccessToken(token);
  },

  /**
   * Verify if token permissions are up to date
   */
  verifyTokenPermissions: (decoded: any): Promise<boolean> => {
    return (async () => {
      try {
        const user = await User.findByPk(decoded.id);
        if (!user) return false;
        return user.permissionVersion === decoded.permissionVersion;
      } catch {
        return false;
      }
    })();
  },

  /**
   * Generate a random token for password reset or email verification
   */
  generateRandomToken: (): string => {
    return crypto.randomBytes(32).toString('hex');
  },

  /**
   * Generate password reset token and expiry
   */
  generatePasswordResetToken: (): {token: string; expires: Date} => {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date();
    expires.setHours(expires.getHours() + 10);
    return {token, expires};
  },
};

function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface RefreshTokenMetadata {
  userAgent?: string;
  ip?: string;
  label?: string;
}

export interface SessionInfo {
  id: string;
  userAgent: string | null;
  ip: string | null;
  label: string | null;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Refresh token service: create, find, revoke, list sessions
 */
export const refreshTokenService = {
  /**
   * Create a new refresh token for user; returns opaque token and sessionId for cross-device management
   */
  async createRefreshToken(
    userId: string,
    metadata?: RefreshTokenMetadata
  ): Promise<{ token: string; expiresAt: Date; sessionId: string }> {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashRefreshToken(token);
    const expiresAt = new Date(Date.now() + JWT_REFRESH_EXPIRES_IN_SEC * 1000);
    const record = await RefreshToken.create({
      userId,
      tokenHash,
      userAgent: metadata?.userAgent,
      ip: metadata?.ip,
      label: metadata?.label,
      expiresAt,
      createdAt: new Date(),
    });
    return { token, expiresAt, sessionId: record.id };
  },

  /**
   * List active sessions (valid refresh tokens) for a user
   */
  async listSessionsForUser(userId: string): Promise<SessionInfo[]> {
    const records = await RefreshToken.findAll({
      where: {
        userId,
        revokedAt: null,
        expiresAt: { [Op.gt]: new Date() },
      },
      attributes: ['id', 'userAgent', 'ip', 'label', 'createdAt', 'expiresAt'],
      order: [['createdAt', 'DESC']],
    });
    return records.map((r) => ({
      id: r.id,
      userAgent: r.userAgent ?? null,
      ip: r.ip ?? null,
      label: r.label ?? null,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    }));
  },

  /**
   * Revoke a session by id (user can only revoke their own)
   */
  async revokeSessionById(sessionId: string, userId: string): Promise<boolean> {
    const [count] = await RefreshToken.update(
      { revokedAt: new Date() },
      { where: { id: sessionId, userId } }
    );
    return count > 0;
  },

  /**
   * Find valid refresh token record by plain token; returns record with user or null
   */
  async findValidRefreshToken(plainToken: string): Promise<RefreshToken | null> {
    const tokenHash = hashRefreshToken(plainToken);
    const record = await RefreshToken.findOne({
      where: {
        tokenHash,
        revokedAt: null,
        expiresAt: { [Op.gt]: new Date() },
      },
      include: [{ model: User, as: 'user' }],
    });
    return record;
  },

  /**
   * Revoke a refresh token by plain token
   */
  async revokeRefreshToken(plainToken: string): Promise<void> {
    const tokenHash = hashRefreshToken(plainToken);
    await RefreshToken.update(
      { revokedAt: new Date() },
      { where: { tokenHash } }
    );
  },

  /**
   * Revoke all refresh tokens for a user
   */
  async revokeAllRefreshTokensForUser(userId: string): Promise<void> {
    await RefreshToken.update(
      { revokedAt: new Date() },
      { where: { userId } }
    );
  },
};

/** Access token cookie maxAge in seconds (15 min) */
export const ACCESS_COOKIE_MAX_AGE_SEC = 15 * 60;
/** Refresh token cookie maxAge in seconds (7 days) */
export const REFRESH_COOKIE_MAX_AGE_SEC = JWT_REFRESH_EXPIRES_IN_SEC;

/**
 * Cookie helper for auth tokens
 */
export const cookieUtils = {
  setAuthCookies(
    res: Response,
    accessToken: string,
    refreshToken: string | null,
    accessMaxAgeSec: number = ACCESS_COOKIE_MAX_AGE_SEC,
    refreshMaxAgeSec: number = REFRESH_COOKIE_MAX_AGE_SEC
  ): void {
    res.cookie(COOKIE_ACCESS, accessToken, {
      ...COOKIE_OPTS,
      maxAge: accessMaxAgeSec * 1000,
    });
    if (refreshToken) {
      res.cookie(COOKIE_REFRESH, refreshToken, {
        ...COOKIE_OPTS,
        maxAge: refreshMaxAgeSec * 1000,
      });
    }
  },

  clearAuthCookies(res: Response): void {
    res.clearCookie(COOKIE_ACCESS, { ...COOKIE_OPTS, path: '/' });
    res.clearCookie(COOKIE_REFRESH, { ...COOKIE_OPTS, path: '/' });
  },

  cookieNames: { access: COOKIE_ACCESS, refresh: COOKIE_REFRESH },
};

/**
 * Email verification utilities
 */
export const emailUtils = {
  /**
   * Generate email verification token
   */
  generateVerificationToken: (): string => {
    return crypto.randomBytes(32).toString('hex');
  },

  /**
   * Generate verification URL
   */
  generateVerificationURL: (token: string): string => {
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    return `${baseUrl}/verify-email?token=${token}`;
  },
};

/**
 * Authentication middleware
 */
export const authMiddleware = {
  /**
   * Extract JWT token from request header
   */
  extractToken: (authHeader: string | undefined): string | null => {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    return authHeader.split(' ')[1];
  },

  /**
   * Validate password strength
   */
  validatePassword: (password: string): boolean => {
    // At least 8 characters, 1 uppercase, 1 lowercase, 1 number
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z\d]{8,}$/;
    return passwordRegex.test(password);
  },

  /**
   * Validate email format
   */
  validateEmail: (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  },
};
