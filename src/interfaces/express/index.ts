import type { LeaderboardCache } from '../../middleware/cache';
import type { AuthUser } from '../auth';
import type { UserAttributes } from '../../models/User';

declare global {
  namespace Express {
    interface Request {
      user?: UserAttributes & {
        provider?: string;
        providerId?: string;
      };
      leaderboardCache?: LeaderboardCache;
    }
    
    interface User extends UserAttributes {
      provider?: string;
      providerId?: string;
    }
  }
}
