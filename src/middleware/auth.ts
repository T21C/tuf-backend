import {Request, Response, NextFunction} from 'express';
import {verifyAccessToken} from '../utils/authHelpers.js';
import {SUPER_ADMINS} from '../config/constants.js';
import {RaterService} from '../services/RaterService.js';

// Create middleware factories for common auth patterns
export const Auth = {
  // For super admin only routes
  superAdmin: () => requireAuth(SUPER_ADMINS),

  // For admin routes
  rater: () => requireAuth([]),

  // For any authenticated user
  user: () => requireAuth([]),

  // For specific roles/users
  allowUsers: (users: string[]) => requireAuth(users),
};

// Base middleware function
function requireAuth(allowedUsersList: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({error: 'Authorization token required'});
      }

      const accessToken = authHeader.split(' ')[1];
      const tokenInfo = await verifyAccessToken(accessToken);

      if (!tokenInfo) {
        return res.status(403).json({error: 'Unauthorized access'});
      }

      // Add tokenInfo to request for use in route handlers
      req.user = tokenInfo;

      // For super admin routes, check if user is in SUPER_ADMINS list
      if (allowedUsersList.length > 0 && allowedUsersList === SUPER_ADMINS) {
        if (!SUPER_ADMINS.includes(tokenInfo.username)) {
          return res.status(403).json({error: 'Unauthorized access'});
        }
        return next();
      }

      // For rater routes, check if user is a rater or super admin
      if (allowedUsersList.length === 0) {
        const isRater = await RaterService.isRater(tokenInfo.id) || SUPER_ADMINS.includes(tokenInfo.username);
        if (!isRater) {
          return res.status(403).json({error: 'Unauthorized access'});
        }
        return next();
      }

      // For specific user lists
      if (allowedUsersList.length > 0 && !allowedUsersList.includes(tokenInfo.username)) {
        return res.status(403).json({error: 'Unauthorized access'});
      }

      next();
    } catch (error) {
      console.error('Auth middleware error:', error);
      return res.status(500).json({error: 'Internal Server Error'});
    }
  };
}
