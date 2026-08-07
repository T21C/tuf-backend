import { Request, Response, NextFunction } from 'express';
import { oauthScopeFlags, hasOAuthScope, parseScopeBitsStored } from '@/config/oauthScopes.js';
import {
  isGrantActive,
  verifyOAuthAccessToken,
} from '@/server/services/oauth/OAuthTokenService.js';

export type OAuthRequestContext = {
  userId: string;
  clientId: string;
  grantId: string;
  scopeBits: bigint;
  scope: string;
};

declare global {
  namespace Express {
    interface Request {
      oauth?: OAuthRequestContext;
    }
  }
}

/** Static whitelist: method + path pattern → required scope flag(s). */
const OAUTH_ROUTE_WHITELIST: readonly {
  method: string;
  pattern: RegExp;
  required: bigint;
}[] = [
  {
    method: 'GET',
    pattern: /^\/oauth\/resource\/user\/?$/,
    required: oauthScopeFlags.USER_READ_PUBLIC,
  },
];

export function matchOAuthWhitelist(
  method: string,
  path: string,
): { required: bigint } | null {
  const verb = method.toUpperCase();
  const normalized = path.split('?')[0].replace(/\/+$/, '') || '/';
  // Keep leading path as given (mounted at root)
  for (const entry of OAUTH_ROUTE_WHITELIST) {
    if (entry.method !== verb) continue;
    if (entry.pattern.test(normalized) || entry.pattern.test(path)) {
      return { required: entry.required };
    }
  }
  return null;
}

/**
 * Middleware for OAuth resource endpoints: Bearer OAuth JWT only.
 * Rejects website session cookies as the auth mechanism for these routes
 * when Authorization Bearer oauth token is expected.
 */
export async function requireOAuthBearer(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'unauthorized', error_description: 'Bearer token required' });
      return;
    }
    const token = authHeader.slice('Bearer '.length).trim();
    const claims = verifyOAuthAccessToken(token);
    if (!claims) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }

    const active = await isGrantActive(claims.gid);
    if (!active) {
      res.status(401).json({ error: 'invalid_token', error_description: 'Grant revoked' });
      return;
    }

    const scopeBits = parseScopeBitsStored(claims.scope_bits);
    const match = matchOAuthWhitelist(req.method, req.path);
    // Also try originalUrl without query (when mounted)
    const match2 =
      match ||
      matchOAuthWhitelist(req.method, (req.originalUrl || req.url || '').split('?')[0]);

    if (!match2) {
      res.status(403).json({ error: 'forbidden', error_description: 'Route not allowed for OAuth' });
      return;
    }
    if (!hasOAuthScope(scopeBits, match2.required)) {
      res.status(403).json({ error: 'insufficient_scope' });
      return;
    }

    req.oauth = {
      userId: claims.sub,
      clientId: claims.client_id,
      grantId: claims.gid,
      scopeBits,
      scope: claims.scope,
    };
    next();
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
}
