import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/authHelpers.js';

export const requireAuth = (allowedUsersList: string[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ error: 'Authorization token required' });
      }

      const accessToken = authHeader.split(' ')[1];
      const tokenInfo = await verifyAccessToken(accessToken);

      if (!tokenInfo || !allowedUsersList.includes(tokenInfo.username)) {
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
};