import { Request, Response, NextFunction } from 'express';
import { logger } from '@/server/services/LoggerService.js';

const SLOW_ENDPOINT_THRESHOLD_MS = process.env.SLOW_ENDPOINT_THRESHOLD_MS
  ? parseInt(process.env.SLOW_ENDPOINT_THRESHOLD_MS, 10)
  : 3000;

const SLOW_LOG_EXCLUDED_ROUTES = [
  '/v2/webhook/*',
  '/v2/database/levels',
  '/v2/database/levels/*/cdnData',
  '/v2/database/levels/*/upload',
  '/v2/database/levels/packs/*/download-link',
  '/v2/form/form-submit',
  '/v2/media/thumbnail/*',
  '/v2/media/image-proxy',
  '/v2/chunked-upload/*',
  '/health',
  '/v2/external/autorate/*',
  '/v2/admin/submissions/auto-approve/*',
  '/v2/media/video-details/*',
  '/v2/auth/profile/avatar',
  '/v2/database/levels/*/upload-from-url',
  '/v2/jobs/*/stream'
];

function isExcludedRoute(path: string): boolean {
  return SLOW_LOG_EXCLUDED_ROUTES.some((pattern) => {
    const escapedPattern = pattern
      .replace(/\*/g, '__WILDCARD__')
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/__WILDCARD__/g, '.*');
    const regex = new RegExp(`^${escapedPattern}$`);
    return regex.test(path);
  });
}

export function slowEndpointLoggingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  const path = req.originalUrl.split('?')[0];
  const route = `${req.method} ${path}`;

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    if (durationMs > SLOW_ENDPOINT_THRESHOLD_MS && !isExcludedRoute(path)) {
      logger.warn(`Slow endpoint (${durationMs.toFixed(0)}ms): ${route}`, {
        status: res.statusCode,
        duration: Math.round(durationMs),
        userId: (req as any).user?.id,
        query: Object.keys(req.query).length > 0 ? req.query : undefined,
      });
    }
  });

  next();
}
