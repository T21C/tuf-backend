/**
 * Paths that must never create/keep performance transactions.
 * Query string is ignored. Do not mirror SLOW_LOG_EXCLUDED_ROUTES.
 */
export function isTraceDenylistedPath(pathOrTransactionName: string): boolean {
  let path = pathOrTransactionName.trim();
  // Transaction names are often "GET /v2/health" or "GET /docs/"
  const methodMatch = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i.exec(path);
  if (methodMatch) {
    path = path.slice(methodMatch[0].length);
  }
  const q = path.indexOf('?');
  if (q >= 0) path = path.slice(0, q);
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      // keep unparsed path
    }
  }
  // Strip trailing slash except root
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  if (path === '/health' || path === '/v2/health') return true;
  if (path === '/openapi.json') return true;
  if (path === '/docs' || path.startsWith('/docs/')) return true;
  // Vite hashed bundles / static files (prod `/assets/…`, Vite dev `/src/assets/…`).
  if (path === '/assets' || path.startsWith('/assets/')) return true;
  if (path === '/src/assets' || path.startsWith('/src/assets/')) return true;
  return false;
}

export function extractPathFromSamplingContext(context: {
  name?: string;
  attributes?: Record<string, unknown>;
  normalizedRequest?: { url?: string; path?: string };
}): string {
  const attrPath =
    (context.attributes?.['http.route'] as string | undefined) ||
    (context.attributes?.['http.target'] as string | undefined) ||
    (context.attributes?.['url.path'] as string | undefined);
  if (attrPath) return attrPath;

  const reqPath = context.normalizedRequest?.path || context.normalizedRequest?.url;
  if (reqPath) {
    try {
      if (reqPath.startsWith('http')) {
        return new URL(reqPath).pathname;
      }
    } catch {
      // fall through
    }
    return reqPath;
  }

  return context.name || '';
}
