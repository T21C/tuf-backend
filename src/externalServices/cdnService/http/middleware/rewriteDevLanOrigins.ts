import type { NextFunction, Request, Response } from 'express';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Match `http(s)://localhost` / `127.0.0.1` so port + path stay intact. */
const LOOPBACK_ORIGIN_RE = /https?:\/\/(?:localhost|127\.0\.0\.1)(?=:\d+|\/|$)/gi;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-rewrite loopback CDN origins in JSON payloads (upload / write responses).
 * Leaves R2 public URLs and unrelated strings alone.
 */
export function rewriteLoopbackOriginsInValue<T>(value: T, lanHost: string): T {
  if (typeof value === 'string') {
    return value.replace(LOOPBACK_ORIGIN_RE, (match) => {
      const protocol = match.startsWith('https') ? 'https://' : 'http://';
      return `${protocol}${lanHost}`;
    }) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => rewriteLoopbackOriginsInValue(item, lanHost)) as T;
  }

  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = rewriteLoopbackOriginsInValue(child, lanHost);
    }
    return out as T;
  }

  return value;
}

/**
 * Dev-only: on CDN write responses, rewrite `localhost` / `127.0.0.1` origins in
 * JSON file links to `CDN_DEV_PUBLIC_HOST` (e.g. LAN IP for SSH/remote clients).
 *
 * No-op unless `NODE_ENV=development` and `CDN_DEV_PUBLIC_HOST` is set.
 */
export function rewriteDevLanOriginsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (process.env.NODE_ENV !== 'development') {
    next();
    return;
  }

  const lanHost = process.env.CDN_DEV_PUBLIC_HOST?.trim();
  if (!lanHost) {
    next();
    return;
  }

  if (!MUTATING_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }

  const originalJson = res.json.bind(res);
  res.json = ((body?: unknown) =>
    originalJson(rewriteLoopbackOriginsInValue(body, lanHost))) as Response['json'];

  next();
}
