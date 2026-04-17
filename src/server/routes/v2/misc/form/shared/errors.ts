import type { Response } from 'express';
import { logger } from '@/server/services/core/LoggerService.js';

/**
 * Canonical error shape used by every new form route. Throw one of these from
 * inside a handler and `sendFormError` will turn it into a clean JSON response.
 */
export class FormError extends Error {
  readonly code: number;
  readonly details?: Record<string, unknown>;
  readonly field?: string;
  constructor(code: number, message: string, opts: { details?: Record<string, unknown>; field?: string } = {}) {
    super(message);
    this.name = 'FormError';
    this.code = code;
    this.details = opts.details;
    this.field = opts.field;
  }
}

export const formError = {
  bad: (message: string, opts?: { details?: Record<string, unknown>; field?: string }) =>
    new FormError(400, message, opts),
  unauth: (message = 'User not authenticated') => new FormError(401, message),
  forbid: (message: string) => new FormError(403, message),
  notFound: (message: string) => new FormError(404, message),
  conflict: (message: string, opts?: { details?: Record<string, unknown>; field?: string }) =>
    new FormError(409, message, opts),
  server: (message = 'Internal server error', opts?: { details?: Record<string, unknown> }) =>
    new FormError(500, message, opts),
};

export function sendFormError(res: Response, err: unknown, fallback = 'Failed to process request'): void {
  if (err instanceof FormError) {
    const payload: Record<string, unknown> = { error: err.message };
    if (err.details) payload.details = err.details;
    if (err.field) payload.field = err.field;
    res.status(err.code).json(payload);
    return;
  }
  // Legacy `{ code, error }` shape still thrown in places we haven't touched yet.
  if (err && typeof err === 'object' && 'code' in err) {
    const legacy = err as { code?: unknown; error?: unknown; details?: unknown };
    const code = typeof legacy.code === 'number' && legacy.code >= 100 && legacy.code < 600 ? legacy.code : 500;
    res.status(code).json({
      error: typeof legacy.error === 'string' ? legacy.error : fallback,
      details: (legacy.details as Record<string, unknown> | undefined) ?? {},
    });
    return;
  }
  logger.error(fallback, err);
  res.status(500).json({ error: fallback });
}
