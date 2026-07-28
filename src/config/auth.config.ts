/**
 * Auth secrets and TTL constants. JWT_SECRET must be set — no insecure fallback.
 */
import dotenv from 'dotenv';

dotenv.config();

const rawSecret = process.env.JWT_SECRET?.trim();
if (!rawSecret) {
  throw new Error(
    'JWT_SECRET environment variable is required. Set it before starting the server.',
  );
}

export const JWT_SECRET: string = rawSecret;

/** Access token cookie / JWT lifetime in seconds (15 min). */
export const ACCESS_TOKEN_TTL_SEC = 15 * 60;

/** Refresh token lifetime in days. */
export const REFRESH_TOKEN_TTL_DAYS = 7;

/** Refresh token lifetime in seconds. */
export const REFRESH_TOKEN_TTL_SEC = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60;

/** Step-up grant cookie / JWT lifetime in seconds (10 min). */
export const STEP_UP_TTL_SEC = 10 * 60;
