import type {LeaderboardCache} from '../../middleware/cache';

export interface IUser {
  id: string;
  username: string;
  access_token: string;
  isSuperAdmin?: boolean;
  roles?: string[];
  avatar?: string;
  discriminator: string;
  public_flags: number;
  flags: number;
  banner?: string;
  accent_color?: number;
  global_name?: string;
  avatar_decoration_data?: {
    asset: string;
    sku_id: string;
    expires_at: string | null;
  };
  banner_color?: string;
  clan?: string | null;
  primary_guild?: string | null;
  mfa_enabled: boolean;
  locale: string;
  premium_type: number;
  email: string;
  verified: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: IUser;
      leaderboardCache?: LeaderboardCache;
    }
  }
}
