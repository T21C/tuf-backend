import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { User } from '../models';

const SALT_ROUNDS = 10;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key'; // Should be in env
const JWT_EXPIRES_IN = '24h';

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
  }
};

/**
 * Token utilities
 */
export const tokenUtils = {
  /**
   * Generate a JWT token for a user
   */
  generateJWT: (user: User): string => {
    const payload = {
      id: user.id,
      email: user.email,
      username: user.username,
      isRater: user.isRater,
      isSuperAdmin: user.isSuperAdmin,
      playerId: user.playerId
    };

    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  },

  /**
   * Verify a JWT token
   */
  verifyJWT: (token: string): any => {
    try {
      return jwt.verify(token, JWT_SECRET);
    } catch (error) {
      return null;
    }
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
  generatePasswordResetToken: (): { token: string; expires: Date } => {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date();
    expires.setHours(expires.getHours() + 1); // Token expires in 1 hour

    return { token, expires };
  }
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
  }
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
  }
}; 