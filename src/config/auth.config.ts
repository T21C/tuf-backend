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

/** Refresh token lifetime in days (sliding via rotation). */
export const REFRESH_TOKEN_TTL_DAYS = 30;

/** Refresh token lifetime in seconds. */
export const REFRESH_TOKEN_TTL_SEC = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60;

/** Step-up grant cookie / JWT lifetime in seconds (10 min). */
export const STEP_UP_TTL_SEC = 10 * 60;

/** Login MFA pending cookie / JWT lifetime in seconds (10 min). */
export const MFA_PENDING_TTL_SEC = 10 * 60;

/** Login MFA pending cookie name (shared with CSRF middleware — the /mfa endpoints authenticate with this cookie alone). */
export const MFA_PENDING_COOKIE = 'mfaPending';

/** Trusted-device cookie / row lifetime in days. */
export const TRUSTED_DEVICE_TTL_DAYS = 30;

/** Trusted-device lifetime in seconds. */
export const TRUSTED_DEVICE_TTL_SEC = TRUSTED_DEVICE_TTL_DAYS * 24 * 60 * 60;
