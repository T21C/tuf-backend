import argon2, { type HashOptions } from 'argon2';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Op } from 'sequelize';
import type { Request, Response } from 'express';
import {User, RefreshToken} from '@/models/index.js';
import { hasFlag } from './permissionUtils.js';
import { permissionFlags } from '@/config/constants.js';
import { lookupIpLocation, type IpLocationInfo } from './ipLocation.js';
import {
  JWT_SECRET,
  ACCESS_TOKEN_TTL_SEC,
  REFRESH_TOKEN_TTL_SEC,
} from '@/config/auth.config.js';

/** Target argon2id params (memoryCost is KiB; 65536 = 64 MiB). */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const satisfies HashOptions;

const JWT_REFRESH_EXPIRES_IN_SEC = REFRESH_TOKEN_TTL_SEC;

const COOKIE_ACCESS = 'accessToken';
const COOKIE_REFRESH = 'refreshToken';
const COOKIE_CSRF = 'csrfToken';

const isSecureAuthCookie = process.env.NODE_ENV !== 'development';

/** Fixed flags for auth cookies (SPA on tuforums.com → api.tuforums.com). Not configurable via env. */
export const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: isSecureAuthCookie,
  // SameSite=None requires Secure; use Lax for local HTTP dev (localhost SPA → localhost API).
  sameSite: (isSecureAuthCookie ? 'none' : 'lax') as 'none' | 'lax',
  path: '/',
};

/** CSRF cookie is readable by JS (double-submit). */
export const CSRF_COOKIE_OPTIONS = {
  httpOnly: false,
  secure: isSecureAuthCookie,
  sameSite: (isSecureAuthCookie ? 'none' : 'lax') as 'none' | 'lax',
  path: '/',
};

function isBcryptHash(hash: string): boolean {
  return hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$');
}

function isArgon2Hash(hash: string): boolean {
  return hash.startsWith('$argon2');
}

export interface PasswordVerifyResult {
  ok: boolean;
  /** Present when verification succeeded and the stored hash should be upgraded. */
  newHash?: string;
}

/**
 * Password utilities — argon2id for new hashes; bcrypt verified and upgraded on success.
 */
export const passwordUtils = {
  /**
   * Hash a password with argon2id (current target parameters).
   */
  hashPassword: async (password: string): Promise<string> => {
    return argon2.hash(password, { ...ARGON2_OPTIONS, raw: false });
  },

  /**
   * Compare a password against a stored bcrypt or argon2 hash.
   */
  comparePassword: async (password: string, hash: string): Promise<boolean> => {
    if (!hash) return false;
    if (isArgon2Hash(hash)) {
      try {
        return await argon2.verify(hash, password);
      } catch {
        return false;
      }
    }
    if (isBcryptHash(hash)) {
      return bcrypt.compare(password, hash);
    }
    return false;
  },

  /**
   * True when the stored hash should be rewritten with current argon2id params.
   */
  needsRehash: (hash: string): boolean => {
    if (!hash) return true;
    if (isBcryptHash(hash)) return true;
    if (isArgon2Hash(hash)) {
      try {
        return argon2.needsRehash(hash, ARGON2_OPTIONS);
      } catch {
        return true;
      }
    }
    return true;
  },

  /**
   * Verify password; on success, return a new argon2id hash when the stored one is outdated.
   */
  verifyAndMaybeRehash: async (
    password: string,
    hash: string,
  ): Promise<PasswordVerifyResult> => {
    const ok = await passwordUtils.comparePassword(password, hash);
    if (!ok) return { ok: false };
    if (passwordUtils.needsRehash(hash)) {
      return { ok: true, newHash: await passwordUtils.hashPassword(password) };
    }
    return { ok: true };
  },
};

function getAccessTokenPayload(user: User, sessionId: string) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    isRater: hasFlag(user, permissionFlags.RATER),
    isSuperAdmin: hasFlag(user, permissionFlags.SUPER_ADMIN),
    permissionFlags: user.permissionFlags.toString(),
    playerId: user.playerId,
    permissionVersion: user.permissionVersion,
    /** Refresh-token session id; access JWTs are rejected once this session is revoked. */
    sid: sessionId,
  };
}

/**
 * Token utilities
 */
export const tokenUtils = {
  /**
   * Generate short-lived access JWT for a user, bound to a refresh-token session.
   */
  generateAccessToken: (user: User, sessionId: string): string => {
    return jwt.sign(
      getAccessTokenPayload(user, sessionId),
      JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_TTL_SEC }
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
   * @deprecated Requires a session id — prefer generateAccessToken(user, sessionId)
   */
  generateJWT: (user: User, sessionId: string): string => {
    return tokenUtils.generateAccessToken(user, sessionId);
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
   * @deprecated Prefer opaqueTokenUtils.generateOpaqueCode for user-facing codes
   */
  generateRandomToken: (): string => {
    return crypto.randomBytes(32).toString('hex');
  },

  /**
   * Generate password reset token and expiry
   * @deprecated Prefer AccountCredentialService password reset flow
   */
  generatePasswordResetToken: (): {token: string; expires: Date} => {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date();
    expires.setHours(expires.getHours() + 10);
    return {token, expires};
  },
};

/** Purpose tags for opaque credential codes (email verify, password reset, step-up). */
export const OPAQUE_TOKEN_PURPOSE = {
  EMAIL_VERIFY: 'email_verify',
  PASSWORD_RESET: 'password_reset',
  STEP_UP: 'step_up',
} as const;

export type OpaqueTokenPurpose =
  (typeof OPAQUE_TOKEN_PURPOSE)[keyof typeof OPAQUE_TOKEN_PURPOSE];

/** Crockford base32 alphabet (no I, L, O, U). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function hashOpaqueToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Opaque code utilities for email verification, password reset, and step-up.
 * Hash input: `${purpose}:${binding}:${userId}:${code}` (binding optional) so codes
 * cannot be reused across users, purposes, or step-up scopes.
 */
export const opaqueTokenUtils = {
  hashOpaqueToken,

  /**
   * Hash a user-bound opaque code for storage.
   * Pass `binding` (e.g. step-up scope) so a `security` code cannot verify as `email-change`.
   */
  hashBoundCode(
    purpose: OpaqueTokenPurpose,
    userId: string,
    code: string,
    binding?: string,
  ): string {
    const normalized = code.trim().toUpperCase();
    const parts = binding
      ? `${purpose}:${binding}:${userId}:${normalized}`
      : `${purpose}:${userId}:${normalized}`;
    return hashOpaqueToken(parts);
  },

  /**
   * Generate an 8-character Crockford base32 code.
   */
  generateOpaqueCode(length = 8): string {
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) {
      out += CROCKFORD[bytes[i]! % CROCKFORD.length];
    }
    return out;
  },

  timingSafeEqualHash(a: string, b: string): boolean {
    try {
      const bufA = Buffer.from(a, 'hex');
      const bufB = Buffer.from(b, 'hex');
      if (bufA.length !== bufB.length) return false;
      return crypto.timingSafeEqual(bufA, bufB);
    } catch {
      return false;
    }
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
  location: IpLocationInfo | null;
  label: string | null;
  createdAt: Date;
  expiresAt: Date;
  isCurrent?: boolean;
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
   * List active sessions (valid refresh tokens) for a user.
   * When currentSessionId is provided, marks that row with isCurrent.
   */
  async listSessionsForUser(
    userId: string,
    currentSessionId?: string | null,
  ): Promise<SessionInfo[]> {
    const records = await RefreshToken.findAll({
      where: {
        userId,
        expiresAt: { [Op.gt]: new Date() },
        revokedAt: null,
      },
      attributes: ['id', 'userAgent', 'ip', 'label', 'createdAt', 'expiresAt'],
      order: [['createdAt', 'DESC']],
    });
    return records.map((r) => ({
      id: r.id,
      userAgent: r.userAgent ?? null,
      ip: r.ip ?? null,
      location: lookupIpLocation(r.ip),
      label: r.label ?? null,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      isCurrent: Boolean(currentSessionId && r.id === currentSessionId),
    }));
  },

  /**
   * Revoke a session by id (user can only revoke their own)
   */
  async revokeSessionById(sessionId: string, userId: string): Promise<boolean> {
    const [affected] = await RefreshToken.update(
      { revokedAt: new Date() },
      { where: { id: sessionId, userId, revokedAt: null } }
    );
    return affected > 0;
  },

  /**
   * Whether a refresh-token session is still usable (not revoked / not expired).
   */
  async isSessionActive(sessionId: string, userId: string): Promise<boolean> {
    if (!sessionId || !userId) return false;
    const record = await RefreshToken.findOne({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
        expiresAt: { [Op.gt]: new Date() },
      },
      attributes: ['id'],
    });
    return Boolean(record);
  },

  /**
   * Revoke all active sessions for a user except the one to keep (current device).
   */
  async revokeOtherSessionsForUser(
    userId: string,
    keepSessionId: string,
  ): Promise<number> {
    const [affected] = await RefreshToken.update(
      { revokedAt: new Date() },
      {
        where: {
          userId,
          revokedAt: null,
          id: { [Op.ne]: keepSessionId },
          expiresAt: { [Op.gt]: new Date() },
        },
      },
    );
    return affected;
  },

  /**
   * Rotate a valid refresh token in place (same session id).
   * Keeps session identity stable across access-token refreshes.
   */
  async rotateRefreshToken(
    plainToken: string,
    metadata?: RefreshTokenMetadata,
  ): Promise<{ token: string; expiresAt: Date; sessionId: string; user: User } | null> {
    const record = await this.findValidRefreshToken(plainToken);
    if (!record?.user) return null;

    // Reload with JWT fields (email is banned on includes; findByPk is intentional).
    const user = await User.findByPk(record.user.id, {
      attributes: [
        'id',
        'email',
        'username',
        'playerId',
        'permissionFlags',
        'permissionVersion',
      ],
    });
    if (!user) return null;

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashRefreshToken(token);
    const expiresAt = new Date(Date.now() + JWT_REFRESH_EXPIRES_IN_SEC * 1000);
    await record.update({
      tokenHash,
      expiresAt,
      userAgent: metadata?.userAgent ?? record.userAgent,
      ip: metadata?.ip ?? record.ip,
    });

    return {
      token,
      expiresAt,
      sessionId: record.id,
      user,
    };
  },

  /**
   * Find valid refresh token record by plain token; returns record with user or null
   */
  async findValidRefreshToken(plainToken: string): Promise<RefreshToken | null> {
    const tokenHash = hashRefreshToken(plainToken);
    const record = await RefreshToken.findOne({
      where: {
        tokenHash,
        expiresAt: { [Op.gt]: new Date() },
        revokedAt: null,
      },
      include: [{
        model: User,
        as: 'user',
        attributes: ['id'],
      }],
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
      { where: { tokenHash, revokedAt: null } }
    );
  },

  /**
   * Revoke all refresh tokens for a user
   */
  async revokeAllRefreshTokensForUser(userId: string): Promise<void> {
    await RefreshToken.update(
      { revokedAt: new Date() },
      { where: { userId, revokedAt: null } }
    );
  },
};

/** Access token cookie maxAge in seconds (15 min) */
export const ACCESS_COOKIE_MAX_AGE_SEC = ACCESS_TOKEN_TTL_SEC;
/** Refresh token cookie maxAge in seconds (matches REFRESH_TOKEN_TTL) */
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
    refreshMaxAgeSec: number = REFRESH_COOKIE_MAX_AGE_SEC,
  ): void {
    res.cookie(COOKIE_ACCESS, accessToken, {
      ...AUTH_COOKIE_OPTIONS,
      maxAge: accessMaxAgeSec * 1000,
    });
    if (refreshToken) {
      res.cookie(COOKIE_REFRESH, refreshToken, {
        ...AUTH_COOKIE_OPTIONS,
        maxAge: refreshMaxAgeSec * 1000,
      });
    }
    // Rotate CSRF token whenever auth cookies are set
    const csrf = crypto.randomBytes(32).toString('hex');
    res.cookie(COOKIE_CSRF, csrf, {
      ...CSRF_COOKIE_OPTIONS,
      maxAge: refreshMaxAgeSec * 1000,
    });
    // Expose to JS for cross-origin SPAs that cannot read the cookie via document.cookie
    res.setHeader('X-CSRF-Token', csrf);
  },

  /**
   * Ensure a CSRF cookie exists and echo the value to the client (body + header).
   * Used so cross-origin SPAs can double-submit without reading host-only API cookies.
   */
  ensureCsrfToken(req: Request, res: Response): string {
    const existing = req.cookies?.[COOKIE_CSRF];
    if (typeof existing === 'string' && existing.length > 0) {
      res.setHeader('X-CSRF-Token', existing);
      return existing;
    }
    const csrf = crypto.randomBytes(32).toString('hex');
    res.cookie(COOKIE_CSRF, csrf, {
      ...CSRF_COOKIE_OPTIONS,
      maxAge: REFRESH_COOKIE_MAX_AGE_SEC * 1000,
    });
    res.setHeader('X-CSRF-Token', csrf);
    return csrf;
  },

  clearAuthCookies(res: Response): void {
    res.clearCookie(COOKIE_ACCESS, AUTH_COOKIE_OPTIONS);
    res.clearCookie(COOKIE_REFRESH, AUTH_COOKIE_OPTIONS);
    res.clearCookie(COOKIE_CSRF, CSRF_COOKIE_OPTIONS);
  },

  cookieNames: { access: COOKIE_ACCESS, refresh: COOKIE_REFRESH, csrf: COOKIE_CSRF },
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
