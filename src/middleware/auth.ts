import {Request, Response, NextFunction} from 'express';
import {User, OAuthProvider} from '../models/index.js';
import {tokenUtils} from '../utils/auth.js';
import type {UserAttributes} from '../models/auth/User.js';
import axios from 'axios';
import Player from '../models/players/Player.js';
import { logger } from '../services/LoggerService.js';

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: UserAttributes & {
        provider?: string;
        providerId?: string;
      };
    }
  }
}

type MiddlewareFunction = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void>;

/**
 * Auth middleware factory
 */

let incorectPasswords: Map<string, number> = new Map();
export const Auth = {
  /**
   * Require authenticated user
   */
  user:
    (): MiddlewareFunction =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
          res.status(401).json({error: 'No token provided'});
          return;
        }

        const decoded = tokenUtils.verifyJWT(token);
        if (!decoded) {
          res.status(401).json({error: 'Invalid token'});
          return;
        }

        // Check if token is about to expire (within 5 minutes)
        const tokenExp = decoded.exp ? decoded.exp * 1000 : 0;
        const fiveMinutes = 5 * 60 * 1000;
        const shouldRefresh = tokenExp - Date.now() < fiveMinutes;

        const user = await User.findByPk(decoded.id, {
          include: [
            {
              model: OAuthProvider,
              as: 'providers',
            },
            {
              model: Player,
              as: 'player',
            },
          ],
        });

        if (!user) {
          res.status(401).json({error: 'User not found'});
          return;
        }

        // Check if permissions are up to date
        const permissionsValid =
          await tokenUtils.verifyTokenPermissions(decoded);
        if (!permissionsValid) {
          // Generate new token with updated permissions
          const newToken = tokenUtils.generateJWT(user);
          res.setHeader('X-New-Token', newToken);
          res.setHeader('X-Permission-Changed', 'true');
        }
        // If token is about to expire, generate a new one
        else if (shouldRefresh) {
          const newToken = tokenUtils.generateJWT(user);
          res.setHeader('X-New-Token', newToken);
        }

        // Check if any OAuth tokens need refresh
        const discordProvider = user.providers?.find(
          p => p.provider === 'discord',
        );
        if (
          discordProvider?.tokenExpiry &&
          new Date(discordProvider.tokenExpiry) <= new Date()
        ) {
          try {
            const response = await axios.post(
              'https://discord.com/api/oauth2/token',
              new URLSearchParams({
                client_id: process.env.DISCORD_CLIENT_ID!,
                client_secret: process.env.DISCORD_CLIENT_SECRET!,
                grant_type: 'refresh_token',
                refresh_token: discordProvider.refreshToken!,
              }),
              {
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
              },
            );

            const {access_token, refresh_token, expires_in} = response.data;
            await discordProvider.update({
              accessToken: access_token,
              refreshToken: refresh_token,
              tokenExpiry: new Date(Date.now() + expires_in * 1000),
            });

            // Generate new JWT with updated expiry
            const newToken = tokenUtils.generateJWT(user);
            res.setHeader('X-New-Token', newToken);
          } catch (error) {
            //logger.error('Failed to refresh Discord token:', error);
            // Continue with request even if refresh fails
          }
        }

        req.user = user;
        next();
      } catch (error) {
        logger.error('Auth middleware error:', error);
        res.status(401).json({error: 'Authentication failed'});
        return;
      }
    },

  /**
   * Require rater privileges
   */
  rater:
    (): MiddlewareFunction =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
          res.status(401).json({error: 'No token provided'});
          return;
        }

        const decoded = tokenUtils.verifyJWT(token);
        if (!decoded) {
          res.status(401).json({error: 'Invalid token'});
          return;
        }

        const user = await User.findByPk(decoded.id);
        if (!user) {
          res.status(401).json({error: 'User not found'});
          return;
        }

        if (!user.isRater) {
          res.status(403).json({error: 'Rater access required'});
          return;
        }

        req.user = user;
        next();
      } catch (error) {
        logger.error('Auth middleware error:', error);
        res.status(401).json({error: 'Authentication failed'});
        return;
      }
    },

  /**
   * Require super admin privileges
   */
  superAdmin:
    (): MiddlewareFunction =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
          res.status(401).json({error: 'No token provided'});
          return;
        }

        const decoded = tokenUtils.verifyJWT(token);
        if (!decoded) {
          res.status(401).json({error: 'Invalid token'});
          return;
        }

        const user = await User.findByPk(decoded.id);
        if (!user) {
          res.status(401).json({error: 'User not found'});
          return;
        }

        if (!user.isSuperAdmin) {
          res.status(403).json({error: 'Super admin access required'});
          return;
        }

        req.user = user;
        next();
      } catch (error) {
        logger.error('Auth middleware error:', error);
        res.status(401).json({error: 'Authentication failed'});
        return;
      }
    },

  /**
   * Require super admin password for sensitive operations
   */
  superAdminPassword: (): MiddlewareFunction => {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        // First ensure user is a super admin
        await Auth.superAdmin()(req, res, () => {
          if (!req.user) {
            res.status(401).json({error: 'User not found'});
            return;
          }
          const {superAdminPassword: superAdminPasswordBody} = req.body;
          const superAdminPasswordHeader =
            req.headers['x-super-admin-password'];
          const superAdminPassword =
            superAdminPasswordBody || superAdminPasswordHeader;
          if (
            !superAdminPassword ||
            superAdminPassword !== process.env.SUPER_ADMIN_KEY
          ){
            incorectPasswords.set(req.user.id, (incorectPasswords.get(req.user.id) || 0) + 1);
            if ((incorectPasswords.get(req.user.id) || 0) >= 5) {
              console.warn(`User ${req.user.id} has made ${incorectPasswords.get(req.user.id)} incorrect password attempts`);
            }
            return res.status(403).json({message: 'Invalid super admin password'});
          }
          if ((incorectPasswords.get(req.user.id) || 0) >= 5) {
            console.warn(`User ${req.user.id} successfully entered password after ${incorectPasswords.get(req.user.id)} incorrect attempts`);
            incorectPasswords.delete(req.user.id);
          }
          return next();
        });
      } catch (error) {
        res.status(500).json({message: 'Authorization failed'});
        return;
      }
    };
  },

  /**
   * Require verified email
   */
  verified: (): MiddlewareFunction => {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        // First ensure user is authenticated
        await Auth.user()(req, res, () => {
          if (!req.user?.isEmailVerified) {
            res.status(403).json({message: 'Email verification required'});
            return;
          }
          next();
        });
      } catch (error) {
        res.status(500).json({message: 'Authorization failed'});
        return;
      }
    };
  },

  /**
   * Allow specific providers only
   */
  provider: (providerName: string): MiddlewareFunction => {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        // First ensure user is authenticated
        await Auth.user()(req, res, () => {
          if (req.user?.provider !== providerName) {
            res.status(403).json({
              message: `This feature requires ${providerName} authentication`,
            });
            return;
          }
          next();
        });
      } catch (error) {
        res.status(500).json({message: 'Authorization failed'});
        return;
      }
    };
  },

  /**
   * Optionally add user to request without blocking
   * Returns true if user was added, false otherwise
   */
  addUserToRequest:
    (): MiddlewareFunction =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
          next();
          return;
        }

        const decoded = tokenUtils.verifyJWT(token);
        if (!decoded) {
          next();
          return;
        }

        const user = await User.findByPk(decoded.id, {
          include: [
            {
              model: Player,
              as: 'player',
            },
          ],
        });
        if (!user) {
          next();
          return;
        }

        req.user = user;
        next();
      } catch (error) {
        // On any error, just continue without user
        logger.error('Optional auth middleware error:', error);
        next();
      }
    },
};
