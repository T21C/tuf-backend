import {LeaderboardCacheClass} from '../utils/LeaderboardCache';

declare global {
  namespace Express {
    interface Request {
      leaderboardCach3e?: LeaderboardCacheClass;
    }
  }
}
