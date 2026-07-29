import type { NextFunction, Request, Response } from 'express';

import { safeEqualSecret } from '@/misc/utils/auth/safeEqualSecret.js';
import { logger } from '@/server/services/core/LoggerService.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Server-to-server gate for CDN write routes. GET/HEAD remain public for asset delivery.
 * Requires `X-CDN-Ingest-Key` matching `CDN_INGEST_SECRET`.
 */
export function requireCdnIngestKey(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }

  const secret = process.env.CDN_INGEST_SECRET?.trim();
  if (!secret) {
    logger.error('CDN_INGEST_SECRET is not configured');
    res.status(503).json({ error: 'CDN ingest not configured' });
    return;
  }

  const header = req.headers['x-cdn-ingest-key'];
  if (typeof header !== 'string' || !safeEqualSecret(header, secret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}
