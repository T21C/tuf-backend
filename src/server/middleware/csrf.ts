import type { Request, Response, NextFunction } from 'express';
import { cookieUtils } from '@/misc/utils/auth/auth.js';

const CSRF_HEADER = 'x-csrf-token';
const CSRF_COOKIE = 'csrfToken';

/**
 * Paths (suffix after /v2) that require CSRF when authenticated via cookies.
 * Matched against req.path relative to the mounted router, or req.originalUrl.
 */
function isCredentialSensitivePath(req: Request): boolean {
  const url = (req.originalUrl || req.url || '').split('?')[0] || '';
  const sensitive = [
    '/v2/auth/step-up',
    '/v2/auth/verify/change-email',
    '/v2/auth/verify/pending-email',
    '/v2/auth/verify/resend',
    '/v2/auth/profile/password',
    '/v2/auth/profile/me/delete',
    '/v2/auth/sessions',
  ];
  return sensitive.some((p) => url === p || url.startsWith(`${p}/`));
}

function usedCookieAuth(req: Request): boolean {
  return Boolean(req.cookies?.[cookieUtils.cookieNames.access]);
}

/**
 * Double-submit CSRF for credential-sensitive cookie-authenticated mutating requests.
 * Bearer-only clients skip this check.
 */
export function requireCsrfForCredentialRoutes(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    next();
    return;
  }
  if (!isCredentialSensitivePath(req)) {
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
