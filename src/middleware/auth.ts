import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/authHelpers.js';
import { raterList, SUPER_ADMINS } from '../config/constants.js';


// Create middleware factories for common auth patterns
export const Auth = {
  // For super admin only routes
  superAdmin: () => requireAuth(SUPER_ADMINS),
  
  // For admin routes
  rater: () => requireAuth(raterList.concat(SUPER_ADMINS)),
  
  // For any authenticated user
  user: () => requireAuth([]),
  
  // For specific roles/users
  allowUsers: (users: string[]) => requireAuth(users)
};

// Base middleware function
function requireAuth(allowedUsersList: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ error: 'Authorization token required' });
      }

      const accessToken = authHeader.split(' ')[1];
      const tokenInfo = await verifyAccessToken(accessToken);

      if (!tokenInfo || (allowedUsersList.length > 0 && !allowedUsersList.includes(tokenInfo.username))) {
        return res.status(403).json({ error: 'Unauthorized access' });
      }

      // Add tokenInfo to request for use in route handlers
      req.user = tokenInfo;
      return next();
    } catch (error) {
      console.error('Auth middleware error:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  };
}