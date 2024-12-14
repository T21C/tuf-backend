import type {LeaderboardCache} from '../../middleware/cache';

export interface IUser {
  username: string;
  access_token: string;
  isSuperAdmin?: boolean;
  roles?: string[];
}

declare global {
  namespace Express {
    interface Request {
      user?: IUser;
      leaderboardCache?: LeaderboardCache;
    }
  }
}
