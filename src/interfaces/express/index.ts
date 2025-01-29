import type {LeaderboardCache} from '../../middleware/cache.js';
import type {UserAttributes} from '../../models/User.js';

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
