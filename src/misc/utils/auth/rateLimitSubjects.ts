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

export function parseClientIp(req: {
  headers: { [key: string]: string | string[] | undefined };
  ip?: string;
  connection?: { remoteAddress?: string };
}): string {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string') {
    return forwardedFor.split(',')[0]?.trim() || '127.0.0.1';
  }
  return req.ip || req.connection?.remoteAddress || '127.0.0.1';
}
