import { createHash } from 'node:crypto';

/**
 * Rate-limit subject keys stored in RateLimit.ip (VARCHAR).
 * Prefer these helpers so IP and user buckets stay consistent.
 */
export type RateLimitSubjectKind = 'ip' | 'user';

export function rateLimitSubjectIp(ip: string): string {
  return `ip:${ip}`;
}

export function rateLimitSubjectUser(userId: string): string {
  return `user:${userId}`;
}

/**
 * Stable, non-PII bucket for unauthenticated account identifiers.
 * Email and username lookup are case-insensitive, so normalize them identically
 * before hashing. Returning null keeps empty/malformed requests on the IP bucket.
 */
export function rateLimitSubjectAccount(identifier: unknown): string | null {
  if (typeof identifier !== 'string') return null;
  const normalized = identifier.trim().normalize('NFKC').toLowerCase();
  if (!normalized) return null;
  const digest = createHash('sha256').update(normalized).digest('hex');
  return `account:${digest}`;
}

export function parseClientIp(req: {
  headers: { [key: string]: string | string[] | undefined };
  ip?: string;
  connection?: { remoteAddress?: string };
}): string {
  // Express resolves req.ip using the configured trusted proxy boundary. Reading
  // X-Forwarded-For directly would let an untrusted client choose its rate-limit key.
  return req.ip || req.connection?.remoteAddress || '127.0.0.1';
}
