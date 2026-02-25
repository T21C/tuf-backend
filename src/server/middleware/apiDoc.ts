/**
 * ApiDoc middleware factory – documents the route for OpenAPI without duplicating path.
 * Use in the middleware array so the route is inferred when we walk the router.
 *
 * Example:
 *   router.get('/health', ApiDoc({ summary: 'Health check', ... }), handler);
 *   router.get('/passes', Auth.addUserToRequest(), ApiDoc({ summary: 'Search passes', ... }), handler);
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

/** Operation spec – summary/description/tags and optional body, query, responses */
export interface ApiDocOperationSpec {
  summary: string;
  description?: string;
  tags?: string[];
  /** Request body schema (for POST/PUT etc.) */
  requestBody?: { description?: string; schema?: JsonSchema };
  /** Query parameters: name -> schema (we'll emit as parameters in: query) */
  query?: Record<string, { description?: string; schema?: JsonSchema }>;
  /** Response status -> spec */
  responses?: Record<number | string, ApiDocResponseSpec>;
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
