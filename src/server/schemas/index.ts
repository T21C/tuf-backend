/**
 * API schemas for OpenAPI docs. One file per domain; add new schemas alongside
 * the routes they document. Import from here or from the specific file.
 *
 * - common: errorResponseSchema, successMessageSchema, idParamSchema (use when no custom schema)
 * - health: health check responses
 * - auth: login, sessions, etc.
 * - levels: level/alias-related responses (extend when adding level API docs)
 */
export * from './common.js';
export * from './health.js';
export * from './auth.js';
export * from './levels.js';
