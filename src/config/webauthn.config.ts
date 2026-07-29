/**
 * WebAuthn / passkey relying-party config, derived from the SPA origin.
 * WebAuthn requires HTTPS or literal localhost — LAN IP origins will not work.
 */
import { clientUrlEnv } from '@/config/app.config.js';
import { logger } from '@/server/services/core/LoggerService.js';

const fallbackOrigin = 'http://localhost:5173';

function parseClientOrigin(): URL {
  const raw = String(clientUrlEnv || fallbackOrigin).trim() || fallbackOrigin;
  try {
    return new URL(raw);
  } catch {
    logger.warn('[WebAuthn] Invalid clientUrlEnv; falling back to localhost', { raw });
    return new URL(fallbackOrigin);
  }
}

const clientOrigin = parseClientOrigin();

export const RP_NAME = 'TUF';
export const RP_ID = clientOrigin.hostname;
export const EXPECTED_ORIGIN = clientOrigin.origin;

/** Challenge row lifetime in seconds. */
export const WEBAUTHN_CHALLENGE_TTL_SEC = 5 * 60;

/** Soft cap on passkeys per account (bounds DB growth and UI clutter). */
export const MAX_PASSKEYS_PER_USER = 10;

const isIpLiteral =
  /^\d{1,3}(\.\d{1,3}){3}$/.test(RP_ID) ||
  (RP_ID.startsWith('[') && RP_ID.includes(':'));

if (isIpLiteral) {
  logger.warn(
    '[WebAuthn] RP_ID is an IP address — browsers reject WebAuthn on non-localhost IPs. Use localhost or a hostname for passkey development.',
    { RP_ID, EXPECTED_ORIGIN },
  );
}
