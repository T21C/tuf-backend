/**
 * OAuth Authorization Server secrets and TTL constants.
 * OAUTH_JWT_SECRET must be set and distinct from JWT_SECRET.
 */
import dotenv from 'dotenv';
import { JWT_SECRET } from './auth.config.js';

dotenv.config();

const rawSecret = process.env.OAUTH_JWT_SECRET?.trim();
if (!rawSecret) {
  throw new Error(
    'OAUTH_JWT_SECRET environment variable is required. Set it before starting the server.',
  );
}
if (rawSecret === JWT_SECRET) {
  throw new Error(
    'OAUTH_JWT_SECRET must be distinct from JWT_SECRET.',
  );
}

export const OAUTH_JWT_SECRET: string = rawSecret;

/** OAuth access JWT lifetime in seconds (60 min). */
export const OAUTH_ACCESS_TOKEN_TTL_SEC = 60 * 60;

/** OAuth refresh token lifetime in days. */
export const OAUTH_REFRESH_TOKEN_TTL_DAYS = 90;

/** OAuth refresh token lifetime in seconds. */
export const OAUTH_REFRESH_TOKEN_TTL_SEC =
  OAUTH_REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60;

/** Authorization code lifetime in seconds. */
export const OAUTH_AUTH_CODE_TTL_SEC = 60;

/** Pending consent cookie / JWT lifetime in seconds. */
export const OAUTH_CONSENT_PENDING_TTL_SEC = 10 * 60;

export const OAUTH_CONSENT_PENDING_COOKIE = 'oauthConsentPending';

/** JWT audience for third-party API access. */
export const OAUTH_TOKEN_AUDIENCE = 'tuf-api';

/** JWT token_use claim value. */
export const OAUTH_TOKEN_USE_ACCESS = 'access';

/** Max OAuth apps per owner. */
export const OAUTH_MAX_CLIENTS_PER_USER = 10;

/** Max redirect URIs per client. */
export const OAUTH_MAX_REDIRECT_URIS = 10;

/** App display name length. */
export const OAUTH_CLIENT_NAME_MIN = 3;
export const OAUTH_CLIENT_NAME_MAX = 64;
