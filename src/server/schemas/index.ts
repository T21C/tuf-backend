/**
 * API schemas for OpenAPI docs. Structure mirrors routes/v2/ under v2/.
 *
 * - common: errorResponseSchema, idParamSpec, standardErrorResponses*, docRequestBody, etc.
 * - health, auth, levels: shared domain schemas
 * - v2/: re-exports per area (admin, database, webhooks, auth, misc, profile)
 */
export * from './common.js';
export * from './health.js';
export * from './auth.js';
export * from './levels.js';
export * from './v2/index.js';
