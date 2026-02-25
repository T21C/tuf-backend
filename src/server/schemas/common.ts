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
