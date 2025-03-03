import {Request, Response} from 'express';
import {Op, CreationAttributes} from 'sequelize';
import {v4 as uuidv4} from 'uuid';
import User from '../models/User.js';
import {emailService} from '../utils/email.js';
import {passwordUtils, tokenUtils} from '../utils/auth.js';

export const authController = {
  /**
   * Register a new user
   */
  async register(req: Request, res: Response) {
    try {
      const {email, password, username} = req.body;

      // Validate input
      if (!email || !password || !username) {
        return res.status(400).json({message: 'All fields are required'});
      }

      // Check if user already exists
      const existingUser = await User.findOne({
        where: {
          email,
        },
      });

      if (existingUser) {
        return res.status(400).json({message: 'Email already registered'});
      }

      // Hash password
      const hashedPassword = await passwordUtils.hashPassword(password);

      // Create verification token
      const verificationToken = tokenUtils.generateRandomToken();

      // Create user with proper type annotations
      const now = new Date();
      const userData: CreationAttributes<User> = {
        id: uuidv4(),
        email,
        username,
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
      };

      const user = await User.create({
        ...userData,
        id: uuidv4(),
        password: hashedPassword,
        isEmailVerified: true, // Auto-verify email
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      // Send verification email
      await emailService.sendVerificationEmail(email, verificationToken);

      // Generate JWT
      const token = tokenUtils.generateJWT(user);

      return res.status(201).json({
        message:
          'Registration successful. Please check your email for verification.',
        token,
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
      const {token} = req.params;

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

      // Update user
      await user.update({
        isEmailVerified: true,
        passwordResetToken: '',
        passwordResetExpires: new Date(), // Set to current time to expire it
      });

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

      const user = await User.findOne({
        where: {email},
      });

      if (!user) {
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
      await emailService.sendVerificationEmail(email, verificationToken);

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
      const {email, password} = req.body;

      // Validate input
      if (!email || !password) {
        return res
          .status(400)
          .json({message: 'Email and password are required'});
      }

      // Find user
      const user = await User.findOne({
        where: {email},
      });

      if (!user) {
        return res.status(401).json({message: 'Invalid credentials'});
      }

      // Verify password
      const isValidPassword = await passwordUtils.comparePassword(
        password,
        user.password!,
      );
      if (!isValidPassword) {
        return res.status(401).json({message: 'Invalid credentials'});
      }

      // Check if email is verified
      if (!user.isEmailVerified) {
        return res
          .status(403)
          .json({message: 'Please verify your email before logging in'});
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
