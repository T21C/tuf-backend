import { Request, Response, NextFunction } from 'express';
import { User, OAuthProvider } from '../models';
import { tokenUtils, authMiddleware } from '../utils/auth';
import type { UserAttributes } from '../models/User';

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

type MiddlewareFunction = (req: Request, res: Response, next: NextFunction) => Promise<void> | void;

/**
 * Auth middleware factory
 */
export const Auth = {
  /**
   * Require authenticated user
   */
  user: (): MiddlewareFunction => {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const token = authMiddleware.extractToken(req.headers.authorization);
        if (!token) {
          res.status(401).json({ message: 'No token provided' });
          return;
        }

        const decoded = tokenUtils.verifyJWT(token);
        if (!decoded) {
          res.status(401).json({ message: 'Invalid token' });
          return;
        }

        // Find user and attach to request
        const user = await User.findByPk(decoded.id, {
          include: [{
            model: OAuthProvider,
            as: 'providers'
          }]
        });

        if (!user) {
          res.status(401).json({ message: 'User not found' });
          return;
        }

        // Add provider info if available
        const mainProvider = user.providers?.[0];
        const userJson = user.toJSON();

        req.user = {
          ...userJson,
          provider: mainProvider?.provider || undefined,
          providerId: mainProvider?.providerId || undefined
        };

        next();
      } catch (error) {
        res.status(401).json({ message: 'Authentication failed' });
        return;
      }
    };
  },

  /**
   * Require rater privileges
   */
  rater: (): MiddlewareFunction => {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        // First ensure user is authenticated
        await Auth.user()(req, res, () => {
          if (!req.user?.isRater) {
            res.status(403).json({ message: 'Requires rater privileges' });
            return;
          }
          next();
        });
      } catch (error) {
        res.status(500).json({ message: 'Authorization failed' });
        return;
      }
    };
  },

  /**
   * Require super admin privileges
   */
  superAdmin: (): MiddlewareFunction => {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        // First ensure user is authenticated
        await Auth.user()(req, res, () => {
          if (!req.user?.isSuperAdmin) {
            res.status(403).json({ message: 'Requires super admin privileges' });
            return;
          }
          next();
        });
      } catch (error) {
        res.status(500).json({ message: 'Authorization failed' });
        return;
      }
    };
  },

  /**
   * Require super admin password for sensitive operations
   */
  superAdminPassword: (): MiddlewareFunction => {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        // First ensure user is a super admin
        await Auth.superAdmin()(req, res, () => {
          const { superAdminPassword } = req.body;
          if (!superAdminPassword || superAdminPassword !== process.env.SUPER_ADMIN_KEY) {
            res.status(403).json({ message: 'Invalid super admin password' });
            return;
          }
          next();
        });
      } catch (error) {
        res.status(500).json({ message: 'Authorization failed' });
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
            res.status(403).json({ message: 'Email verification required' });
            return;
          }
          next();
        });
      } catch (error) {
        res.status(500).json({ message: 'Authorization failed' });
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
            res.status(403).json({ message: `This feature requires ${providerName} authentication` });
            return;
          }
          next();
        });
      } catch (error) {
        res.status(500).json({ message: 'Authorization failed' });
        return;
      }
    };
  }
};
