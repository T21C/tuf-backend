import type { Request, Response, NextFunction } from 'express';
import { cookieUtils } from '@/misc/utils/auth/auth.js';

const CSRF_HEADER = 'x-csrf-token';
const CSRF_COOKIE = 'csrfToken';

/**
 * Paths (prefixes) exempt from CSRF. Only machine-to-machine callers belong here:
 * they authenticate with a provider signature or shared-secret header and cannot
 * perform a double-submit. Browser-reachable routes are never exempt — enforcement
 * is the default so a new endpoint is protected without touching this file.
 */
const CSRF_EXEMPT_PREFIXES = [
  '/v2/webhook', // Discord + Stripe provider callbacks
  '/v2/cdn', // job progress / download ingest (x-job-ingest-key, x-download-ingest-key)
];

function isCsrfExemptPath(req: Request): boolean {
  const url = (req.originalUrl || req.url || '').split('?')[0] || '';
  return CSRF_EXEMPT_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`));
}

/**
 * True when the request carries either session cookie. Auth cookies are SameSite=None
 * in production, so any such request is cross-site forgeable and must prove CSRF.
 * The refresh cookie counts too — /auth/refresh and /auth/logout act on it alone.
 */
function usedCookieAuth(req: Request): boolean {
  return Boolean(
    req.cookies?.[cookieUtils.cookieNames.access] ||
      req.cookies?.[cookieUtils.cookieNames.refresh],
  );
}

/**
 * Double-submit CSRF for every cookie-authenticated mutating request.
 * Bearer-only clients and signature/secret-authenticated callers skip this check.
 */
export function requireCsrfForCookieAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    next();
    return;
  }
  if (isCsrfExemptPath(req)) {
    next();
    return;
  }
  if (!usedCookieAuth(req)) {
    next();
    return;
  }

  const header = req.headers[CSRF_HEADER];
  const cookie = req.cookies?.[CSRF_COOKIE];
  const headerVal = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : '';

  if (!cookie || !headerVal || cookie !== headerVal) {
    res.status(403).json({ message: 'Invalid CSRF token', code: 'CSRF_INVALID' });
    return;
  }
  next();
}
