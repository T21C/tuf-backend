import type { JsonSchema } from '@/server/middleware/apiDoc.js';

/**
 * Request body for POST /v2/auth/login
 */
export interface LoginRequestBody {
  emailOrUsername: string;
  password: string;
  captchaToken?: string;
}

/**
 * Successful login response
 */
export interface LoginSuccessResponse {
  message: string;
  user: {
    id: string;
    username: string;
    email: string;
    isRater: boolean;
    isSuperAdmin: boolean;
    isEmailVerified: boolean;
    permissionFlags: string;
  };
  expiresIn: number;
  sessionId: string;
}

/**
 * Error response when credentials are invalid or captcha required
 */
export interface LoginErrorResponse {
  message?: string;
  error?: string;
  requireCaptcha?: boolean;
}

/** JSON Schema for login request body */
export const loginRequestBodySchema: JsonSchema = {
  type: 'object',
  required: ['emailOrUsername', 'password'],
  properties: {
    emailOrUsername: { type: 'string', description: 'Email or username' },
    password: { type: 'string', description: 'User password' },
    captchaToken: { type: 'string', description: 'Optional captcha token when rate-limited' },
  },
};

/** JSON Schema for login 200 response */
export const loginSuccessResponseSchema: JsonSchema = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    user: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        username: { type: 'string' },
        email: { type: 'string' },
        isRater: { type: 'boolean' },
        isSuperAdmin: { type: 'boolean' },
        isEmailVerified: { type: 'boolean' },
        permissionFlags: { type: 'string' },
      },
      required: ['id', 'username', 'email', 'isRater', 'isSuperAdmin', 'isEmailVerified', 'permissionFlags'],
    },
    expiresIn: { type: 'number' },
    sessionId: { type: 'string' },
  },
  required: ['message', 'user', 'expiresIn', 'sessionId'],
};

/** JSON Schema for login 400/500 error response */
export const loginErrorResponseSchema: JsonSchema = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    error: { type: 'string' },
    requireCaptcha: { type: 'boolean' },
  },
};

/** Session item (for GET /auth/sessions) */
export const sessionItemSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    userId: { type: 'string' },
    createdAt: { type: 'string' },
    lastUsedAt: { type: 'string' },
    userAgent: { type: 'string' },
    ip: { type: 'string' },
  },
};

/** GET /auth/sessions response */
export const sessionsListResponseSchema: JsonSchema = {
  type: 'array',
  items: sessionItemSchema,
  description: 'List of active sessions',
};
