import {Request, Response} from 'express';
import {Op, CreationAttributes} from 'sequelize';
import {v4 as uuidv4} from 'uuid';
import User from '../models/User.js';
import Player from '../models/Player.js';
import PlayerStats from '../models/PlayerStats.js';
import {emailService} from '../utils/email.js';
import {passwordUtils, tokenUtils} from '../utils/auth.js';
import {PlayerStatsService} from '../services/PlayerStatsService.js';
import {createRateLimiter} from '../utils/rateLimiter.js';

// Create rate limiter for registration
const registrationLimiter = createRateLimiter({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  maxAttempts: 1,//5,                // 5 accounts per 24 hours
  blockDuration: 8 * 60 * 60 * 1000, // 8 hours block
  type: 'registration'           // Specific type for registration
});

// Create rate limiter for login attempts
const loginLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,     // 1 hour
  maxAttempts: 1,//15,               // 10 attempts per hour
  blockDuration: 10 * 60 * 1000, // 10 minutes block
  type: 'login'                  // Specific type for login
});

// Create rate limiter for verification email resends
const verificationLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,     // 1 hour
  maxAttempts: 1,//10,                // 10 attempts per hour
  blockDuration: 30 * 60 * 1000, // 30 minutes block
  type: 'verification'           // Specific type for verification
});

export const authController = {
  /**
   * Register a new user
   */
  async register(req: Request, res: Response) {
    try {
      const {email, password, username} = req.body;

      // Get client IP for rate limiting
      const forwardedFor = req.headers['x-forwarded-for'];
      const ip = typeof forwardedFor === 'string' 
        ? forwardedFor.split(',')[0].trim() 
        : req.ip || req.connection.remoteAddress || '127.0.0.1';

      // Check if IP is already blocked
      const { blocked, retryAfter } = await registrationLimiter.isBlocked(ip);
      if (blocked) {
        return res.status(429).json({
          message: 'Too many registration attempts. Please try again later.',
          retryAfter,
        });
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
        username: finalUsername, // Use the final username (might be modified if duplicate in Player table)
        password: hashedPassword,
        passwordResetToken: verificationToken,
        passwordResetExpires: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
        isEmailVerified: false,
        isRater: false,
        isSuperAdmin: false,
        isRatingBanned: false,
        status: 'active',
        lastLogin: now,
        updatedAt: now,
        createdAt: now,
        permissionVersion: 1,
        playerId: player.id, // Associate with the created player
      };

      const user = await User.create(userData);

      // Send verification email
      await emailService.sendVerificationEmail(email, verificationToken);

      // Generate JWT
      const token = tokenUtils.generateJWT(user);

      // Increment rate limit after successful registration
      await registrationLimiter.increment(ip);

      return res.status(201).json({
        message: 'Registration successful. Please check your email for verification.',
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          isRater: user.isRater,
          isSuperAdmin: user.isSuperAdmin,
          isEmailVerified: user.isEmailVerified,
        },
        usernameModified: finalUsername !== username,
      });
    } catch (error) {
      console.error('Registration error:', error);
      return res.status(500).json({message: 'Registration failed'});
    }
  },

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
      if (user.isEmailVerified) {
        return res.status(200).json({message: 'Email already verified'});
      }

      // Update user
      await user.update({
        isEmailVerified: true,
        passwordResetToken: '', // Clear the token
        passwordResetExpires: new Date(), // Set to current time to expire it
      });
      await user.increment('permissionVersion', {by: 1});
      // Force update ranks
      await PlayerStatsService.getInstance().forceUpdateRanks();

      return res.json({message: 'Email verified successfully'});
    } catch (error) {
      console.error('Email verification error:', error);
      return res.status(500).json({message: 'Email verification failed'});
    }
  },

  /**
   * Resend verification email
   */
  async resendVerification(req: Request, res: Response) {
    try {
      const {email} = req.body;

      // Get client IP for rate limiting
      const forwardedFor = req.headers['x-forwarded-for'];
      const ip = typeof forwardedFor === 'string' 
        ? forwardedFor.split(',')[0].trim() 
        : req.ip || req.connection.remoteAddress || '127.0.0.1';

      // Check if IP is already blocked
      const { blocked, retryAfter } = await verificationLimiter.isBlocked(ip);
      if (blocked) {
        return res.status(429).json({
          message: 'Too many verification email requests. Please try again later.',
          retryAfter,
        });
      }

      if (!email) {
        return res.status(400).json({message: 'Email is required'});
      }

      const user = await User.findOne({
        where: {email},
      });

      if (!user) {
        // Increment rate limit for failed request
        await verificationLimiter.increment(ip);
        return res.status(404).json({message: 'User not found'});
      }

      if (user.isEmailVerified) {
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
        // Increment rate limit for failed email send
        await verificationLimiter.increment(ip);
        return res.status(500).json({message: 'Failed to send verification email'});
      }

      // Increment rate limit after successful email send
      await verificationLimiter.increment(ip);

      return res.json({message: 'Verification email sent'});
    } catch (error) {
      console.error('Resend verification error:', error);
      return res
        .status(500)
        .json({message: 'Failed to resend verification email'});
    }
  },

  /**
   * Login with email and password
   */
  async login(req: Request, res: Response) {
    try {
      const {emailOrUsername, password} = req.body;

      // Get client IP for rate limiting
      const forwardedFor = req.headers['x-forwarded-for'];
      const ip = typeof forwardedFor === 'string' 
        ? forwardedFor?.split(',')[0].trim() 
        : req.ip || req.connection?.remoteAddress || '127.0.0.1';

      // Check if IP is already blocked
      const { blocked, retryAfter } = await loginLimiter.isBlocked(ip);
      if (blocked) {
        return res.status(429).json({
          message: 'Too many login attempts. Please try again later.',
          retryAfter,
        });
      }

      // Validate input
      if (!emailOrUsername || !password) {
        return res
          .status(400)
          .json({message: 'Email/Username and password are required'});
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
        // Increment rate limit for failed login
        await loginLimiter.increment(ip);
        return res.status(401).json({message: 'Invalid credentials'});
      }

      // Verify password
      const isValidPassword = await passwordUtils.comparePassword(
        password,
        user.password!,
      );
      if (!isValidPassword) {
        // Increment rate limit for failed login
        await loginLimiter.increment(ip);
        return res.status(401).json({message: 'Invalid credentials'});
      }


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
          isRater: user.isRater,
          isSuperAdmin: user.isSuperAdmin,
        },
      });
    } catch (error) {
      console.error('Login error:', error);
      return res.status(500).json({message: 'Login failed'});
    }
  },
};
