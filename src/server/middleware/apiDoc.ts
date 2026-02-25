/**
 * ApiDoc middleware factory – Nest-like API documentation for OpenAPI/Swagger.
 * Use in the route middleware array; the collector infers path from the router stack.
 *
 * Nest-like options: summary, description, tags, operationId, deprecated,
 * params (path params), query, requestBody, responses, security (e.g. ['bearerAuth']).
 * Path params in the URL (e.g. :id) are auto-emitted; use params to add descriptions/schema.
 *
 * Example:
 *   router.get('/health', ApiDoc({ operationId: 'getHealth', summary: 'Health check', tags: ['Health'], responses: { 200: { schema: healthSchema } } }), handler);
 *   router.get('/levels/:id', Auth.user(), ApiDoc({ summary: 'Get level', tags: ['Levels'], security: ['bearerAuth'], params: { id: { schema: idParamSchema } }, responses: { 200: { schema: levelSchema } } }), handler);
 */
import { Request, Response, NextFunction } from 'express';

/** OpenAPI-compatible JSON Schema (subset we need for request/response docs) */
export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  description?: string;
  additionalProperties?: boolean;
  [key: string]: unknown;
};

/** Response spec: description + optional schema (inline JSON Schema) */
export interface ApiDocResponseSpec {
  description?: string;
  schema?: JsonSchema;
}

/** Path or query parameter spec (Nest-like) */
export interface ApiDocParamSpec {
  description?: string;
  schema?: JsonSchema;
  required?: boolean;
}

/** Operation spec – Nest-like: summary, description, tags, operationId, params, body, responses, security */
export interface ApiDocOperationSpec {
  summary: string;
  description?: string;
  /** Tags for grouping in Swagger (e.g. ['Auth'], ['Levels']) */
  tags?: string[];
  /** Unique id for codegen / client SDK (e.g. 'getHealth', 'postAuthRefresh') */
  operationId?: string;
  /** Mark operation as deprecated */
  deprecated?: boolean;
  /** Path parameters (e.g. { id: { description: 'Level ID', schema: { type: 'integer' } } }) */
  params?: Record<string, ApiDocParamSpec>;
  /** Request body schema (for POST/PUT etc.) */
  requestBody?: { description?: string; schema?: JsonSchema; required?: boolean };
  /** Query parameters: name -> spec (emitted as parameters in: query) */
  query?: Record<string, ApiDocParamSpec>;
  /** Response status -> spec */
  responses?: Record<number | string, ApiDocResponseSpec>;
  /** Security requirement names (e.g. ['bearerAuth']). Emitted as security on the operation. */
  security?: string[];
}

/** Symbol to attach spec to the middleware function so the router walk can find it */
export const API_DOC_SPEC = Symbol.for('ApiDoc.spec');

type ApiDocMiddleware = ((req: Request, res: Response, next: NextFunction) => void) & {
  [API_DOC_SPEC]?: ApiDocOperationSpec;
};

/**
 * Returns a middleware that carries the given operation spec.
 * Does nothing at request time (just calls next()); the spec is read when
 * we collect documented routes from the router stack.
 */
export function ApiDoc(spec: ApiDocOperationSpec): ApiDocMiddleware {
  const mw: ApiDocMiddleware = (req: Request, res: Response, next: NextFunction) => {
    next();
  };
  (mw as unknown as Record<symbol, ApiDocOperationSpec>)[API_DOC_SPEC] = spec;
  return mw;
}

export default ApiDoc;
