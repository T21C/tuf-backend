import crypto from 'crypto';

/**
 * Constant-time string compare for shared secrets / ingest keys.
 * Returns false when lengths differ (timingSafeEqual requires equal-length buffers).
 */
export function safeEqualSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}
