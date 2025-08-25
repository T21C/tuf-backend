import {Request, Response} from 'express';
import {Op, CreationAttributes} from 'sequelize';
import {v4 as uuidv4} from 'uuid';
import User from '../models/auth/User.js';
import Player from '../models/players/Player.js';
import PlayerStats from '../models/players/PlayerStats.js';
import {emailService} from '../utils/email.js';
import {passwordUtils, tokenUtils} from '../utils/auth.js';
import {PlayerStatsService} from '../services/PlayerStatsService.js';
import { logger } from '../services/LoggerService.js';
import CaptchaService from '../services/CaptchaService.js';
import { RateLimiter } from '../decorators/rateLimiter.js';
import { permissionFlags } from '../config/app.config.js';
import { hasFlag, setUserPermissionAndSave } from '../utils/permissionUtils.js';

// Create a singleton instance of CaptchaService
const captchaService = new CaptchaService();


// Track failed login attempts
const failedAttempts = new Map<string, {count: number; timestamp: number}>();
const ATTEMPT_TIMEOUT = 30 * 60 * 1000; // 30 minutes in milliseconds

// Helper to check if captcha is required
const isCaptchaRequired = (ip: string): boolean => {
  const attempts = failedAttempts.get(ip);
  if (!attempts) return false;

  // Clear attempts if timeout has passed
  if (Date.now() - attempts.timestamp > ATTEMPT_TIMEOUT) {
    failedAttempts.delete(ip);
    return false;
  }
  logger.debug(`Login attempt failed for ${ip}. Attempts: ${attempts.count}`);
  return attempts.count >= 1;
};

// Helper to record failed login attempt
const recordFailedAttempt = (identifier: string): void => {
  const attempts = failedAttempts.get(identifier) || { count: 0, timestamp: Date.now() };
  attempts.count += 1;
  attempts.timestamp = Date.now();
  failedAttempts.set(identifier, attempts);
  logger.debug(`Recorded failed login attempt for ${identifier}. Total attempts: ${attempts.count}`);
};

class AuthController {
  /**
   * Register a new user
   */
  @RateLimiter({
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    maxAttempts: 5,
    blockDuration: 8 * 60 * 60 * 1000, // 8 hours block
    type: 'registration',
    incrementOnFailure: false,
    incrementOnSuccess: true,
  })
  public async register(req: Request, res: Response): Promise<Response> {
    try {
      const {email, password, username, captchaToken} = req.body;

      if (captchaToken) {
        const isValidCaptcha = await captchaService.verifyCaptcha(captchaToken, 'registration');
        if (!isValidCaptcha) {
          return res.status(400).json({message: 'Invalid captcha'});
        }
      }

      // Validate input
      if (!email || !password || !username) {
        return res.status(400).json({message: 'All fields are required'});
      }

      // Validate email format
      const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({message: 'Invalid email format'});
      }

      // Validate username length (3-20 characters)
      if (username.length < 3 || username.length > 20) {
        return res.status(400).json({message: 'Username must be between 3 and 20 characters'});
      }

      // Validate username contains only alphanumeric characters, underscores (_) and hyphens (-)
      const usernameRegex = /^[a-zA-Z0-9_-]+$/;
      if (!usernameRegex.test(username)) {
        return res.status(400).json({message: 'Username can only contain alphanumeric characters, underscores _ and hyphens -'});
      }

      // Validate password length (minimum 8 characters)
      if (password.length < 8) {
        return res.status(400).json({message: 'Password must be at least 8 characters long'});
      }

      // Check if user already exists with this email
      const existingUser = await User.findOne({
        where: {
          email,
        },
      });

      if (existingUser) {
        return res.status(400).json({message: 'Email already registered'});
      }

      // Check if username already exists in User table
      const existingUsername = await User.findOne({
        where: {
          username,
        },
      });

      if (existingUsername) {
        return res.status(400).json({message: 'Username already taken'});
      }

      // Check if username exists in Player table
      let finalUsername = username;
      let usernameExists = true;
      let attempts = 0;
      const maxAttempts = 10; // Limit attempts to prevent infinite loop
      
      while (usernameExists && attempts < maxAttempts) {
        const existingPlayer = await Player.findOne({
          where: {
            name: finalUsername,
          },
        });
        
        if (!existingPlayer) {
          usernameExists = false;
        } else {
          // Generate a random number between 1 and 999999
          const randomNum = Math.floor(Math.random() * 999999) + 1;
          finalUsername = `${username}_${randomNum}`;
          attempts++;
        }
      }
      
      if (usernameExists) {
        return res.status(400).json({message: 'Could not generate a unique username. Please try a different username.'});
      }

      // Hash password
      const hashedPassword = await passwordUtils.hashPassword(password);

      // Create verification token
      const verificationToken = tokenUtils.generateRandomToken();

      // Create player first
      const player = await Player.create({
        name: finalUsername,
        country: 'XX', // Default country code
        isBanned: false,
        isSubmissionsPaused: false,
      });

      // Create player stats
      await PlayerStats.create({
        id: player.id,
        rankedScore: 0,
        generalScore: 0,
        ppScore: 0,
        wfScore: 0,
        score12K: 0,
        rankedScoreRank: -1,
        generalScoreRank: -1,
        ppScoreRank: -1,
        wfScoreRank: -1,
        score12KRank: -1,
        averageXacc: 0,
        universalPassCount: 0,
        worldsFirstCount: 0,
        topDiffId: 0,
        top12kDiffId: 0,
        lastUpdated: new Date(),
      });

      // Create user with proper type annotations
      const now = new Date();
      const userData: CreationAttributes<User> = {
        id: uuidv4(),
        email,
        username, // Use the final username (might be modified if duplicate in Player table)
        password: hashedPassword,
        passwordResetToken: verificationToken,
        passwordResetExpires: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
        isEmailVerified: false, // Keep for backward compatibility
        isRater: false, // Keep for backward compatibility
        isSuperAdmin: false, // Keep for backward compatibility
        isRatingBanned: false, // Keep for backward compatibility
        status: 'active',
        lastLogin: now,
        updatedAt: now,
        createdAt: now,
        permissionVersion: 1,
        playerId: player.id, // Associate with the created player
        permissionFlags: 0n, // Start with no permissions
      };

      const user = await User.create(userData);

      // Send verification email
      await emailService.sendVerificationEmail(email, verificationToken);

      // Generate JWT
      const token = tokenUtils.generateJWT(user);

      return res.status(201).json({
        message: 'Registration successful. Please check your email for verification.',
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          isRater: hasFlag(user, permissionFlags.RATER),
          isSuperAdmin: hasFlag(user, permissionFlags.SUPER_ADMIN),
          isEmailVerified: hasFlag(user, permissionFlags.EMAIL_VERIFIED),
          permissionFlags: user.permissionFlags,
        },
        usernameModified: finalUsername !== username,
      });
    } catch (error) {
      logger.error('Registration error:', error);
      return res.status(500).json({message: 'Registration failed'});
    }
  }

  /**
   * Verify email with token
   */
  async verifyEmail(req: Request, res: Response) {
    try {
      const {token} = req.body;

      if (!token) {
        return res.status(400).json({message: 'Verification token is required'});
      }

      // Find user with token
      const user = await User.findOne({
        where: {
          passwordResetToken: token,
          passwordResetExpires: {
            [Op.gt]: new Date(), // Token not expired
          },
        },
      });

      if (!user) {
        return res
          .status(400)
          .json({message: 'Invalid or expired verification token'});
      }

      // Check if already verified
      if (hasFlag(user, permissionFlags.EMAIL_VERIFIED)) {
        return res.status(200).json({message: 'Email already verified'});
      }

      // Update user with new permission flags
      await setUserPermissionAndSave(user, permissionFlags.EMAIL_VERIFIED, true);
      await user.update({
        passwordResetToken: '', // Clear the token
        passwordResetExpires: new Date(), // Set to current time to expire it
      });
      // Force update ranks
      await PlayerStatsService.getInstance().updateRanks();

      return res.json({message: 'Email verified successfully'});
    } catch (error) {
      logger.error('Email verification error:', error);
      return res.status(500).json({message: 'Email verification failed'});
    }
  }

  /**
   * Resend verification email
   */
  @RateLimiter({
    windowMs: 60 * 60 * 1000,     // 1 hour
    maxAttempts: 25,
    blockDuration: 30 * 60 * 1000, // 30 minutes block
    type: 'verification',
    incrementOnSuccess: true // Increment on failed verification attempts
  })
  public async resendVerification(req: Request, res: Response): Promise<Response> {
    try {
      const {email} = req.body;

      if (!email) {
        return res.status(400).json({message: 'Email is required'});
      }

      const user = await User.findOne({
        where: {email},
      });

      if (!user) {
        return res.status(404).json({message: 'User not found'});
      }

      if (hasFlag(user, permissionFlags.EMAIL_VERIFIED)) {
        return res.status(400).json({message: 'Email already verified'});
      }

      // Generate new verification token
      const verificationToken = tokenUtils.generateRandomToken();

      // Update user
      await user.update({
        passwordResetToken: verificationToken,
        passwordResetExpires: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
      });

      // Send verification email
      const emailSent = await emailService.sendVerificationEmail(email, verificationToken);
      
      if (!emailSent) {
        return res.status(500).json({message: 'Failed to send verification email'});
      }

      return res.json({message: 'Verification email sent'});
    } catch (error) {
      logger.error('Resend verification error:', error);
      return res
        .status(500)
        .json({message: 'Failed to resend verification email'});
    }
  }

  /**
   * Login with email and password
   */
  @RateLimiter({
    windowMs: 60 * 60 * 1000,     // 1 hour
    maxAttempts: 25,
    blockDuration: 10 * 60 * 1000, // 10 minutes block
    type: 'login',
    incrementOnFailure: true // Increment on failed login attempts to prevent brute force
  })
  public async login(req: Request, res: Response): Promise<Response> {
    try {
      const {emailOrUsername, password, captchaToken} = req.body;

      // Get client IP for captcha check
      const forwardedFor = req.headers['x-forwarded-for'];
      const ip = typeof forwardedFor === 'string' 
        ? forwardedFor?.split(',')[0].trim() 
        : req.ip || req.connection?.remoteAddress || '127.0.0.1';

      // Validate input
      if (!emailOrUsername || !password) {
        return res
          .status(400)
          .json({message: 'Email/Username and password are required'});
      }

      // Check if captcha is required
      const captchaRequired = isCaptchaRequired(ip);
      if (captchaRequired) {
        if (!captchaToken) {
          return res
            .status(400)
            .json({
              error: 'Captcha required', 
              requireCaptcha: true,
              message: 'Please complete the captcha verification to continue'
            });
        }

        const isValidCaptcha = await captchaService.verifyCaptcha(captchaToken, 'login');
        if (!isValidCaptcha) {
          recordFailedAttempt(ip);
          return res
            .status(400)
            .json({
              error: 'Invalid captcha or high risk score detected', 
              requireCaptcha: true,
              message: 'Captcha verification failed. Please try again.'
            });
        }
      }

      // Find user by email or username
      const user = await User.findOne({
        where: {
          [Op.or]: [
            { email: emailOrUsername },
            { username: emailOrUsername }
          ]
        },
      });

      if (!user) {
        return res.status(401).json({
          message: 'Invalid credentials',
          requireCaptcha: isCaptchaRequired(ip)
        });
      }

      // Check if user has a password set
      if (!user.password) {
        return res.status(400).json({message: 'Account not linked to a password. Please use OAuth to login.'});
      }

      // Verify password
      const isValidPassword = await passwordUtils.comparePassword(
        password,
        user.password,
      );
      if (!isValidPassword) {
        return res.status(401).json({
          message: 'Invalid credentials',
          requireCaptcha: isCaptchaRequired(ip)
        });
      }

      // Clear failed attempts on successful login
      failedAttempts.delete(ip);

      // Update last login
      await user.update({lastLogin: new Date()});

      // Generate JWT
      const token = tokenUtils.generateJWT(user);

      return res.json({
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          isRater: hasFlag(user, permissionFlags.RATER),
          isSuperAdmin: hasFlag(user, permissionFlags.SUPER_ADMIN),
          isEmailVerified: hasFlag(user, permissionFlags.EMAIL_VERIFIED),
          permissionFlags: user.permissionFlags,
        },
      });
    } catch (error) {
      logger.error('Login error:', error);
      return res.status(500).json({message: 'Login failed'});
    }
  }

  /**
   * Request password reset
   */
  @RateLimiter({
    windowMs: 60 * 60 * 1000,     // 1 hour
    maxAttempts: 3,
    blockDuration: 30 * 60 * 1000, // 30 minutes block
    type: 'password-reset',
    incrementOnFailure: false,
    incrementOnSuccess: true,
  })
  public async requestPasswordReset(req: Request, res: Response): Promise<Response> {
    try {
      const {email, captchaToken} = req.body;

      if (!email) {
        return res.status(400).json({message: 'Email is required'});
      }

      // Validate email format
      const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({message: 'Invalid email format'});
      }

      // Check if captcha is required (after 2 failed attempts)
      const ip = req.headers['x-forwarded-for'] as string || req.ip || '127.0.0.1';
      const captchaRequired = isCaptchaRequired(ip);
      
      if (captchaRequired) {
        if (!captchaToken) {
          return res.status(400).json({
            error: 'Captcha required',
            requireCaptcha: true,
            message: 'Please complete the captcha verification to continue'
          });
        }

        const isValidCaptcha = await captchaService.verifyCaptcha(captchaToken, 'password-reset');
        if (!isValidCaptcha) {
          return res.status(400).json({
            error: 'Invalid captcha',
            requireCaptcha: true,
            message: 'Captcha verification failed. Please try again.'
          });
        }
      }

      // Find user by email
      const user = await User.findOne({
        where: {email},
      });

      if (!user) {
        // Don't reveal if user exists or not
        return res.json({message: 'If an account with that email exists, a password reset link has been sent.'});
      }

      // Check if user has a password set
      if (!user.password) {
        return res.json({message: 'If an account with that email exists, a password reset link has been sent.'});
      }

      // Generate reset token
      const resetToken = tokenUtils.generateRandomToken();

      // Update user with reset token (expires in 1 hour)
      await user.update({
        passwordResetToken: resetToken,
        passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
      });

      // Send password reset email
      const emailSent = await emailService.sendPasswordResetEmail(email, resetToken);
      
      if (!emailSent) {
        logger.error('Failed to send password reset email to:', email);
        return res.status(500).json({message: 'Failed to send password reset email'});
      }

      return res.json({message: 'If an account with that email exists, a password reset link has been sent.'});
    } catch (error) {
      logger.error('Password reset request error:', error);
      return res.status(500).json({message: 'Failed to process password reset request'});
    }
  }

  /**
   * Reset password with token
   */
  public async resetPassword(req: Request, res: Response): Promise<Response> {
    try {
      const {token, password} = req.body;

      if (!token || !password) {
        return res.status(400).json({message: 'Token and password are required'});
      }

      // Validate password length
      if (password.length < 8) {
        return res.status(400).json({message: 'Password must be at least 8 characters long'});
      }

      // Find user with valid token
      const user = await User.findOne({
        where: {
          passwordResetToken: token,
          passwordResetExpires: {
            [Op.gt]: new Date(), // Token not expired
          },
        },
      });

      if (!user) {
        return res.status(400).json({message: 'Invalid or expired reset token'});
      }

      // Hash new password
      const hashedPassword = await passwordUtils.hashPassword(password);

      // Update user password and clear reset token
      await user.update({
        password: hashedPassword,
        passwordResetToken: null,
        passwordResetExpires: null,
      });

      return res.json({message: 'Password reset successfully'});
    } catch (error) {
      logger.error('Password reset error:', error);
      return res.status(500).json({message: 'Failed to reset password'});
    }
  }
}

// Export a singleton instance
export const authController = new AuthController();
