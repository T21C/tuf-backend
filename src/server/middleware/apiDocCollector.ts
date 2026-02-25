/**
 * OpenAPI spec from the running Express app (no rebuild).
 *
 * Where Express stores middlewares / how we find documentable routes:
 *
 * - Express keeps all middleware and route handlers on the app's internal router
 *   at app._router.stack (Express 4). Each item is a "layer" (path + handle).
 *
 * - A layer is either:
 *   (1) A route layer: layer.route exists. Then layer.route.path is the route path
 *       (e.g. '/') and layer.route.stack is the list of handlers for that route, one
 *       per method (get/post/...). Each of those has .method and .handle (the function).
 *   (2) A router layer: layer.handle is another router (has .stack). The layer's
 *       path (from layer.path or layer.regexp) is the mount path (e.g. '/v2').
 *
 * - "Which routes can be documented?" Any route whose handler list includes the
 *   ApiDoc() middleware. ApiDoc(spec) returns a function that has a property
 *   keyed by the symbol API_DOC_SPEC. When we walk route.stack we call
 *   getSpecFromHandler(routeLayer.handle); if that returns a spec, we treat that
 *   path+method as documented. So only routes that actually use ApiDoc() in their
 *   middleware array appear in the generated spec.
 *
 * - Nothing is "written" by the api docs system into Express. We only read the
 *   existing stack and the spec objects attached to the ApiDoc() function refs.
 *
 * Example pathway to "auth" route definitions (nested routers):
 *
 *   app._router.stack
 *     → layer where handle is main router (app.use('/', routes))
 *   → handle.stack  (routes/index: router.use('/v2', v2Router))
 *     → layer where path /v2, handle = v2Router
 *   → handle.stack  (v2/index: router.use('/auth', authRoutes))
 *     → layer where path /auth, handle = authRoutes
 *   → handle.stack  (v2/auth/index: router.post('/refresh', ...), etc.)
 *     → layer.route.path === '/refresh' (and others), layer.route.stack = [post handler, ...]
 *   → for each routeLayer in route.stack: getSpecFromHandler(routeLayer.handle)
 *     → if handler has API_DOC_SPEC, collect { path: '/v2/auth/refresh', method: 'post', spec }
 *
 * So "auth" definitions are found by recursing: app → routes → v2 → auth → route layers → handlers.
 */
import type { Express, IRouter } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { API_DOC_SPEC, type ApiDocOperationSpec } from './apiDoc.js';

export interface CollectedRouteDoc {
  path: string;
  method: string;
  spec: ApiDocOperationSpec;
}

/** Express layer (internal) */
interface RouterLayer {
  route?: { path: string; stack: Array<{ method?: string; handle?: unknown }> };
  name?: string;
  path?: string;
  handle?: { stack?: RouterLayer[] };
  regexp?: RegExp;
}

/**
 * Get mount path from a layer. Express sets layer.path only when match() runs,
 * so for static mounts we derive from regexp.source. Strip regex syntax so we
 * only keep literal path segments (e.g. /v2/?(?=/|$) -> /v2).
 */
function getLayerPath(layer: RouterLayer): string {
  // Example input: "/v2/database/levels/:id"
  // 1. If layer.path is present and not empty, use it.
  if (layer.path !== undefined && layer.path !== '') {
    // For "/v2/database/levels/:id", layer.path might be "/:id" or part of the mount
    return layer.path;
  }

  // Extract the regexp (built by Express for this mount)
  const re = layer.regexp as RegExp & { fast_slash?: boolean };
  // Express creates a fast_slash property for root ("/")
  if (re?.fast_slash) {
    // For "/v2/database/levels/:id", re.fast_slash is false, so continue
    return '';
  }

  // src example: for "/v2/database/levels/:id" the regex source might look like:
  // ^\\/v2\\/database\\/levels(?:\\/([^\\/]+?))?\\/?(?=\\/|$)
  const src = re?.source ?? '';
  // ^\\/v2\\/database\\/levels(?:\\/([^\\/]+?))?\\/?(?=\\/|$)

  // Remove start-of-string and end-of-string regex markers:
  // After this: "\\/v2\\/database\\/levels(?:\\/([^\\/]+?))?\\/?(?=\\/|$)"
  const pathPart = src
    .replace(/^\^/, '')      // ^ removed, now "\\/v2\\/database\\/levels(?:\\/([^\\/]+?))?\\/?(?=\\/|$)"
    .replace(/\$$/, '')      // (no trailing $ in many cases)
    .replace(/\\\//g, '/');  // Converts "\/" to "/": "/v2/database/levels(?:/([^/]+?))?/?(?=/|$)"

  // Split by "/" and remove empty segments:
  // For "/v2/database/levels(?:/([^/]+?))?/?(?=/|$)" --> ['v2', 'database', 'levels(?:', '([^', ']+?))?', '(?=', '|$)']
  const segments = pathPart
    .split('/')
    .filter(Boolean)
    .map((seg) =>
      // Remove trailing regex syntax: (? [ ] ) and everything after so closing ) ] are stripped too
      seg.replace(/\[?(\[)\]\].*/, '')
    );

  // After the .map, example for input "/v2/database/levels/:id":
  // ['v2', 'database', 'levels', '', '', '']

  // Only keep segments that are literal (alphanumeric, underscore, dot, hyphen), not params:
  // So param or regex-segments are filtered out. Only literal path is kept.
  const literalOnly = segments.filter((s) => /^[a-zA-Z0-9_.-:]+$/.test(s)).join('/');

  // For the current example: joins as "v2/database/levels"
  // Finally return as "/v2/database/levels", or "" if nothing matched.
  return literalOnly ? `/${literalOnly}` : '';
}

function normalizePath(parts: string[]): string {
  const joined = parts.filter(Boolean).join('/').replace(/\/+/g, '/');
  return '/' + joined.replace(/^\//, '') || '/';
}

function getSpecFromHandler(handle: unknown): ApiDocOperationSpec | undefined {
  if (handle == null) return undefined;
  const h = handle as Record<symbol, ApiDocOperationSpec | undefined>;
  if (API_DOC_SPEC in h && h[API_DOC_SPEC]) return h[API_DOC_SPEC];
  return undefined;
}

function collectFromStack(stack: RouterLayer[], basePathParts: string[]): CollectedRouteDoc[] {
  const results: CollectedRouteDoc[] = [];
  const stackList = Array.isArray(stack) ? stack : [];

  for (const layer of stackList) {
    if (layer.route) {
      const routePath = layer.route.path ?? '';
      const pathParts = [...basePathParts, routePath.replace(/^\//, '')].filter(Boolean);
      const fullPath = normalizePath(pathParts);

      for (const routeLayer of layer.route.stack ?? []) {
        const method = (routeLayer.method ?? 'get').toLowerCase();
        const spec = getSpecFromHandler(routeLayer.handle);
        if (spec) {
          results.push({ path: fullPath, method, spec });
        }
      }
      continue;
    }

    const handle = layer.handle as { stack?: RouterLayer[] } | undefined;
    if (handle && Array.isArray(handle.stack)) {
      const rawPath = getLayerPath(layer);
      const mountPath = rawPath.replace(/^\//, '').replace(/\/$/, '');
      const newParts = mountPath ? [...basePathParts, mountPath] : basePathParts;
      results.push(...collectFromStack(handle.stack, newParts));
    }
  }

  return results;
}

/**
 * Collect all documented routes from an Express app or router.
 * Call after all routes are mounted.
 * When given an Express app, uses app._router.stack (Express 4 internal).
 */
export function collectDocSpecsFromRouter(appOrRouter: Express | IRouter): CollectedRouteDoc[] {
  const appLike = appOrRouter as { _router?: { stack?: RouterLayer[] }; stack?: RouterLayer[] };
  const stack = appLike._router?.stack ?? appLike.stack ?? [];
  return collectFromStack(stack, []);
}

/** Extract path param names from route path (e.g. /levels/:id/aliases -> ['id']) */
function getPathParamNames(routePath: string): string[] {
  const names: string[] = [];
  const segments = routePath.split('/').filter(Boolean);
  for (const seg of segments) {
    if (seg.startsWith(':')) {
      const name = seg.replace(/^:(.+?)(?:\(.*\))?$/, '$1');
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * Convert Express path to OpenAPI path. OpenAPI uses {param} for path parameters;
 * Swagger UI "Try it out" substitutes {id} with the user's value. Express uses :id or :id(regex).
 */
function toOpenApiPath(routePath: string): string {
  return routePath
    .split('/')
    .map((seg) => {
      if (!seg.startsWith(':')) return seg;
      const name = seg.replace(/^:(.+?)(?:\(.*\))?$/, '$1');
      return name ? `{${name}}` : seg;
    })
    .join('/');
}

/**
 * Build OpenAPI 3.0 paths and components from collected route docs.
 * Supports Nest-like operationId, params, security, deprecated.
 */
export function buildOpenApiFromCollectedSpecs(
  collected: CollectedRouteDoc[],
  options: { title?: string; version?: string; description?: string } = {}
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  let needsBearerSecurity = false;

  for (const { path: routePath, method, spec } of collected) {
    const openApiPath = toOpenApiPath(routePath);
    if (!paths[openApiPath]) paths[openApiPath] = {};

    const operation: Record<string, unknown> = {
      summary: spec.summary,
      ...(spec.description && { description: spec.description }),
      ...(spec.tags?.length && { tags: spec.tags }),
      ...(spec.operationId && { operationId: spec.operationId }),
      ...(spec.deprecated === true && { deprecated: true }),
    };

    const parameters: unknown[] = [];

    // Path parameters: from spec.params and/or inferred from route path (e.g. :id)
    const pathParamNames = getPathParamNames(routePath);
    for (const name of pathParamNames) {
      const paramSpec = spec.params?.[name];
      parameters.push({
        name,
        in: 'path',
        required: true,
        ...(paramSpec?.description && { description: paramSpec.description }),
        schema: paramSpec?.schema ?? { type: 'string', description: 'Resource identifier' },
      });
    }

    if (spec.query && Object.keys(spec.query).length > 0) {
      for (const [name, param] of Object.entries(spec.query)) {
        parameters.push({
          name,
          in: 'query',
          ...(param.description && { description: param.description }),
          ...(param.required !== undefined && { required: param.required }),
          schema: param.schema ?? { type: 'string' },
        });
      }
    }
    if (parameters.length > 0) operation.parameters = parameters;

    if (spec.requestBody?.schema || spec.requestBody?.description) {
      operation.requestBody = {
        required: spec.requestBody.required !== false,
        content: {
          'application/json': {
            ...(spec.requestBody.description && { description: spec.requestBody.description }),
            ...(spec.requestBody.schema && { schema: spec.requestBody.schema }),
          },
        },
      };
    }

    if (spec.responses && Object.keys(spec.responses).length > 0) {
      operation.responses = {};
      for (const [code, response] of Object.entries(spec.responses)) {
        (operation.responses as Record<string, unknown>)[String(code)] = {
          description: response.description ?? (code === '200' ? 'OK' : `Response ${code}`),
          ...(response.schema && {
            content: {
              'application/json': { schema: response.schema },
            },
          }),
        };
      }
    }

    if (spec.security?.length) {
      operation.security = spec.security.map((name) => ({ [name]: [] }));
      if (spec.security.includes('bearerAuth')) needsBearerSecurity = true;
    }

    paths[openApiPath][method] = operation;
  }

  const components: Record<string, unknown> = {
    schemas: {},
    ...(needsBearerSecurity && {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Session or access token',
        },
      },
    }),
  };

  return {
    openapi: '3.0.3',
    info: {
      title: options.title ?? 'API',
      version: options.version ?? '1.0.0',
      description: options.description ?? '',
    },
    paths,
    components,
  };
}

export interface GenerateOpenApiOptions {
  title?: string;
  version?: string;
  description?: string;
  /** If set, write the spec JSON to this path (e.g. dist.tmp/openapi.json). */
  writePath?: string;
}

/**
 * Single entry point: from the running app, collect ApiDoc() routes and build
 * the OpenAPI spec. No rebuild or separate process. Optionally write to disk.
 * Returns the OpenAPI document object.
 */
export async function generateOpenApiFromApp(
  app: Express,
  options: GenerateOpenApiOptions = {}
): Promise<Record<string, unknown>> {
  const { writePath, ...info } = options;
  const collected = collectDocSpecsFromRouter(app);
  const spec = buildOpenApiFromCollectedSpecs(collected, info);

  if (writePath) {
    const dir = path.dirname(writePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(writePath, JSON.stringify(spec, null, 2), 'utf8');
  }

  return spec;
}
