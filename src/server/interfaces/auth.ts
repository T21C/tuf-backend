// Base interface for authenticated user
export interface AuthUser {
  id: string;
  username: string;
  provider: string;
  userId: number;
  email?: string;
  isRater?: boolean;
  isSuperAdmin?: boolean;
}

// Extended interface for Discord user data
export interface DiscordUser extends AuthUser {
  access_token: string;
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
  verified: boolean;
}
