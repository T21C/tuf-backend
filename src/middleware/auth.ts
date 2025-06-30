import {Request, Response, NextFunction} from 'express';
import {User, OAuthProvider} from '../models/index.js';
import {tokenUtils} from '../utils/auth.js';
import type {UserAttributes} from '../models/auth/User.js';
import axios from 'axios';
import Player from '../models/players/Player.js';
import { logger } from '../services/LoggerService.js';
import { AuditLogService } from '../services/AuditLogService.js';
import PlayerStats from '../models/players/PlayerStats.js';
import Difficulty from '../models/levels/Difficulty.js';

const getUser = async (id: string): Promise<User | null> => {
  return await User.findByPk(id, {
    include: [
      {
        model: OAuthProvider,
        as: 'providers',
      },
      {
        model: Player,
        as: 'player',
        include: [
          {
            model: PlayerStats,
            as: 'stats',
            include: [
              {
                model: Difficulty,
                as: 'topDiff',
              },
            ],
          },
        ],
      },
    ],
  });
};

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
 * Base authentication middleware - handles token verification and user lookup
 */
const baseAuth: MiddlewareFunction = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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

    // Check if token is about to expire (within 5 minutes)
    const tokenExp = decoded.exp ? decoded.exp * 1000 : 0;
    const fiveMinutes = 5 * 60 * 1000;
    const shouldRefresh = tokenExp - Date.now() < fiveMinutes;

    // Check if permissions are up to date
    const permissionsValid = await tokenUtils.verifyTokenPermissions(decoded);
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
    const discordProvider = user.providers?.find(p => p.provider === 'discord');
    if (discordProvider?.tokenExpiry && new Date(discordProvider.tokenExpiry) <= new Date()) {
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
        // Continue with request even if refresh fails
      }
    }

    const fullUser = await getUser(decoded.id);
    if (!fullUser) {
      res.status(401).json({error: 'User not found'});
      return;
    }

    req.user = fullUser;
    next();
  } catch (error) {
    logger.error('Auth middleware error:', error);
    res.status(401).json({error: 'Authentication failed'});
    return;
  }
};

/**
 * Chain middleware functions together
 */
const chainMiddleware = (...middlewares: MiddlewareFunction[]): MiddlewareFunction => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let index = 0;
    
    const executeNext = async () => {
      if (index >= middlewares.length) {
        return next();
      }
      
      const middleware = middlewares[index];
      index++;
      
      try {
        await middleware(req, res, executeNext);
      } catch (error) {
        logger.error('Middleware chain error:', error);
        res.status(500).json({error: 'Internal server error'});
      }
    };
    
    await executeNext();
  };
};

/**
 * Permission check middleware factory
 */
const requirePermission = (checkFn: (user: UserAttributes) => boolean, errorMessage: string): MiddlewareFunction => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({error: 'User not found'});
      return;
    }
    
    if (!checkFn(req.user)) {
      res.status(403).json({error: errorMessage});
      return;
    }
    
    next();
  };
};

/**
 * Audit logging middleware
 */
const auditLogMiddleware: MiddlewareFunction = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  // Only log modification methods
  const MODIFICATION_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
  if (MODIFICATION_METHODS.includes(req.method)) {
    const oldJson = res.json;
    const oldSend = res.send;
    let responseBody: any;

    res.json = function (body: any) {
      responseBody = body;
      return oldJson.call(this, body);
    };
    res.send = function (body: any) {
      responseBody = JSON.parse(body);
      return oldSend.call(this, body);
    };

    res.on('finish', async () => {
      // Only log successful (2xx/3xx) responses
      if (res.statusCode < 200 || res.statusCode >= 400) return;
      await AuditLogService.log({
        userId: req.user?.id ?? null,
        action: req.route?.path || req.originalUrl,
        route: req.originalUrl,
        method: req.method,
        payload: req.body,
        result: responseBody,
      });
    });
  }
  
  next();
};

let incorectPasswords: Map<string, number> = new Map();

/**
 * Auth middleware factory
 */
export const Auth = {
  /**
   * Require authenticated user
   */
  user: (): MiddlewareFunction => baseAuth,

  /**
   * Require rater privileges
   */
  rater: (): MiddlewareFunction => 
    chainMiddleware(
      baseAuth,
      requirePermission(
        (user) => user.isRater,
        'Rater access required'
      )
    ),

  /**
   * Require super admin privileges
   */
  superAdmin: (): MiddlewareFunction => 
    chainMiddleware(
      baseAuth,
      requirePermission(
        (user) => user.isSuperAdmin,
        'Super admin access required'
      ),
      auditLogMiddleware
    ),

  /**
   * Require super admin password for sensitive operations
   */
  superAdminPassword: (): MiddlewareFunction => {
    return chainMiddleware(
      Auth.superAdmin(),
      async (req: Request, res: Response, next: NextFunction) => {
        const {superAdminPassword: superAdminPasswordBody} = req.body;
        const superAdminPasswordHeader = req.headers['x-super-admin-password'];
        const superAdminPassword = superAdminPasswordBody || superAdminPasswordHeader;
        
        if (!superAdminPassword || superAdminPassword !== process.env.SUPER_ADMIN_KEY) {
          incorectPasswords.set(req.user!.id, (incorectPasswords.get(req.user!.id) || 0) + 1);
          if ((incorectPasswords.get(req.user!.id) || 0) >= 5) {
            logger.warn(`User ${req.user!.id} has made ${incorectPasswords.get(req.user!.id)} incorrect password attempts`);
          }
          res.status(403).json({message: 'Invalid super admin password'});
          return;
        }
        
        if ((incorectPasswords.get(req.user!.id) || 0) >= 5) {
          logger.warn(`User ${req.user!.id} successfully entered password after ${incorectPasswords.get(req.user!.id)} incorrect attempts`);
          incorectPasswords.delete(req.user!.id);
        }
        
        next();
      }
    );
  },

  /**
   * Require verified email
   */
  verified: (): MiddlewareFunction => 
    chainMiddleware(
      baseAuth,
      requirePermission(
        (user) => user.isEmailVerified,
        'Email verification required'
      )
    ),

  /**
   * Allow specific providers only
   */
  provider: (providerName: string): MiddlewareFunction => 
    chainMiddleware(
      baseAuth,
      requirePermission(
        (user) => {
          // Check if user has the specified provider
          return user.providers?.some(p => p.provider === providerName) || false;
        },
        `This feature requires ${providerName} authentication`
      )
    ),

  /**
   * Optionally add user to request without blocking
   * Returns true if user was added, false otherwise
   */
  addUserToRequest: (): MiddlewareFunction =>
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
