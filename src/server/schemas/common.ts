import type { JsonSchema } from '@/server/middleware/apiDoc.js';

/** Shared error shape used across many endpoints (400, 404, 500) */
export interface ErrorResponse {
  error?: string;
  message?: string;
}

/** Generic 400/404/500 error schema for ApiDoc when no custom error schema is needed */
export const errorResponseSchema: JsonSchema = {
  type: 'object',
  description: 'Error response',
  properties: {
    error: { type: 'string', description: 'Error message' },
    message: { type: 'string', description: 'Alternative message field' },
  },
};

/** Simple success message (e.g. { message: 'OK' }) */
export const successMessageSchema: JsonSchema = {
  type: 'object',
  description: 'Success response',
  properties: {
    message: { type: 'string' },
  },
  required: ['message'],
};

/** Path param :id (numeric ID) – use in ApiDoc params when route has :id */
export const idParamSchema: JsonSchema = {
  type: 'string',
  description: 'Resource ID',
  pattern: '^[0-9]{1,20}$',
};

/** ApiDoc params spec for numeric :id – use as params: { id: idParamSpec } */
export const idParamSpec = { schema: idParamSchema };

/** Path param :id (string, e.g. UUID) – use when id is not numeric */
export const stringIdParamSchema: JsonSchema = {
  type: 'string',
  description: 'Resource ID',
};

/** ApiDoc params spec for string :id */
export const stringIdParamSpec = { schema: stringIdParamSchema };

/** Request body schema: { passIds: number[] } – webhooks and similar */
export const passIdsBodySchema: JsonSchema = {
  type: 'object',
  properties: { passIds: { type: 'array', items: { type: 'integer' } } },
  required: ['passIds'],
};

/** Request body schema: { levelIds: number[] } – webhooks and similar */
export const levelIdsBodySchema: JsonSchema = {
  type: 'object',
  properties: { levelIds: { type: 'array', items: { type: 'integer' } } },
  required: ['levelIds'],
};

/** Build requestBody for ApiDoc: description + schema + required. */
export function docRequestBody(
  description: string,
  schema: JsonSchema,
  required = true
): { description: string; schema: JsonSchema; required: boolean } {
  return { description, schema, required };
}

/** Spread into ApiDoc responses for 400, 404, 500 with errorResponseSchema */
export const standardErrorResponses = {
  400: { schema: errorResponseSchema },
  404: { schema: errorResponseSchema },
  500: { schema: errorResponseSchema },
} as const;

/** Spread for 400 + 500 only (e.g. webhooks) */
export const standardErrorResponses400500 = {
  400: { schema: errorResponseSchema },
  500: { schema: errorResponseSchema },
} as const;

/** Spread for 404 + 500 only */
export const standardErrorResponses404500 = {
  404: { schema: errorResponseSchema },
  500: { schema: errorResponseSchema },
} as const;

/** Spread for 500 only */
export const standardErrorResponses500 = {
  500: { schema: errorResponseSchema },
} as const;

/** Spread for 401 + 500 */
export const standardErrorResponses401500 = {
  401: { schema: errorResponseSchema },
  500: { schema: errorResponseSchema },
} as const;

/** Spread for 401 + 404 + 500 */
export const standardErrorResponses401404500 = {
  401: { schema: errorResponseSchema },
  404: { schema: errorResponseSchema },
  500: { schema: errorResponseSchema },
} as const;

/** Spread for 403 + 404 + 500 */
export const standardErrorResponses403404500 = {
  403: { schema: errorResponseSchema },
  404: { schema: errorResponseSchema },
  500: { schema: errorResponseSchema },
} as const;

/** Single error response spec for ad-hoc use (e.g. 409) */
export function errorResponse(status: number) {
  return { [status]: { schema: errorResponseSchema } } as const;
}
