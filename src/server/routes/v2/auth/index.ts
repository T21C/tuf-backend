import {Router} from 'express';
import loginRoutes from './login.js';
import registerRoutes from './register.js';
import verificationRoutes from './verification.js';
import oauthRoutes from './oauth.js';
import profileRoutes from '@/server/routes/v2/profile/profile.js';
import forgotPasswordRoutes from './forgotPassword.js';
import passkeyRoutes from './passkeys.js';
import { authController } from '@/server/controllers/auth.js';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {
  successMessageSchema,
  errorResponseSchema,
  sessionsListResponseSchema,
  stringIdParamSpec,
} from '@/server/schemas/v2/auth/index.js';
import { stepUpGrantService } from '@/server/services/auth/StepUpGrantService.js';

const router: Router = Router();

router.use('/login', loginRoutes);
router.use('/register', registerRoutes);
router.use('/verify', verificationRoutes);
router.use('/oauth', oauthRoutes);
router.use('/profile', profileRoutes);
router.use('/forgot-password', forgotPasswordRoutes);
router.use('/passkeys', passkeyRoutes);
router.post(
  '/step-up/email',
  Auth.user(),
  ApiDoc({
    operationId: 'postAuthStepUpEmail',
    summary: 'Request step-up email code',
    description:
      'Send a one-time confirmation code to the current verified email to unlock a sensitive action',
    tags: ['Auth'],
    security: ['bearerAuth'],
    requestBody: {
      description: 'Step-up scope',
      schema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['email-change', 'security'] },
        },
      },
      required: false,
    },
    responses: {
      200: { description: 'Code sent', schema: successMessageSchema },
      400: { schema: errorResponseSchema },
      401: { schema: errorResponseSchema },
      403: { schema: errorResponseSchema },
      429: { schema: errorResponseSchema },
    },
  }),
  (req, res) => authController.requestStepUpEmail(req, res),
);
router.post(
  '/step-up',
  Auth.user(),
  ApiDoc({
    operationId: 'postAuthStepUp',
    summary: 'Step-up authentication',
    description:
      'Confirm with an emailed code (verified accounts) or password / OAuth (add-first-email only) to unlock sensitive account actions for a short window',
    tags: ['Auth'],
    security: ['bearerAuth'],
    requestBody: {
      description: 'Confirmation code and/or password, plus scope',
      schema: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          password: { type: 'string' },
          scope: { type: 'string', enum: ['email-change', 'security'] },
        },
      },
      required: false,
    },
    responses: {
      200: { description: 'Step-up granted', schema: successMessageSchema },
      400: { schema: errorResponseSchema },
      401: { schema: errorResponseSchema },
      403: { schema: errorResponseSchema },
      429: { schema: errorResponseSchema },
    },
  }),
  (req, res) => authController.stepUp(req, res),
);
router.post(
  '/mfa/email',
  ApiDoc({
    operationId: 'postAuthMfaEmail',
    summary: 'Request login MFA email code',
    description:
      'Send a one-time login code to the verified email for the current MFA-pending challenge',
    tags: ['Auth'],
    responses: {
      200: { description: 'Code sent', schema: successMessageSchema },
      400: { schema: errorResponseSchema },
      401: { schema: errorResponseSchema },
      429: { schema: errorResponseSchema },
    },
  }),
  (req, res) => authController.requestLoginMfaEmail(req, res),
);
router.post(
  '/mfa/verify',
  ApiDoc({
    operationId: 'postAuthMfaVerify',
    summary: 'Verify login MFA',
    description:
      'Confirm the login MFA code and issue a session. Optionally remember this device for 30 days.',
    tags: ['Auth'],
    requestBody: {
      description: 'MFA code and remember-device flag',
      schema: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          rememberDevice: { type: 'boolean' },
        },
        required: ['code'],
      },
      required: true,
    },
    responses: {
      200: { description: 'Session issued', schema: successMessageSchema },
      400: { schema: errorResponseSchema },
      401: { schema: errorResponseSchema },
      429: { schema: errorResponseSchema },
    },
  }),
  (req, res) => authController.verifyLoginMfa(req, res),
);
router.post(
  '/mfa/passkey/options',
  ApiDoc({
    operationId: 'postAuthMfaPasskeyOptions',
    summary: 'Begin login MFA with a passkey',
    description:
      'Return WebAuthn options restricted to passkeys for the MFA-pending account',
    tags: ['Auth'],
    responses: {
      200: { description: 'Authentication options' },
      400: { schema: errorResponseSchema },
      401: { schema: errorResponseSchema },
      429: { schema: errorResponseSchema },
    },
  }),
  (req, res) => authController.requestLoginMfaPasskeyOptions(req, res),
);
router.post(
  '/mfa/passkey/verify',
  ApiDoc({
    operationId: 'postAuthMfaPasskeyVerify',
    summary: 'Verify login MFA with a passkey',
    description:
      'Confirm the passkey assertion for the MFA-pending login and issue a session',
    tags: ['Auth'],
    requestBody: {
      description: 'Authentication response and remember-device flag',
      schema: {
        type: 'object',
        properties: {
          response: { type: 'object' },
          rememberDevice: { type: 'boolean' },
        },
        required: ['response'],
      },
      required: true,
    },
    responses: {
      200: { description: 'Session issued', schema: successMessageSchema },
      400: { schema: errorResponseSchema },
      401: { schema: errorResponseSchema },
      429: { schema: errorResponseSchema },
    },
  }),
  (req, res) => authController.verifyLoginMfaPasskey(req, res),
);
router.get(
  '/trusted-devices',
  Auth.user(),
  ApiDoc({
    operationId: 'getAuthTrustedDevices',
    summary: 'List trusted devices',
    description: 'Devices that skip login MFA for this account',
    tags: ['Auth'],
    security: ['bearerAuth'],
    responses: {
      200: { description: 'List of trusted devices', schema: successMessageSchema },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
    },
  }),
  (req, res) => authController.getTrustedDevices(req, res),
);
router.delete(
  '/trusted-devices/:id',
  Auth.user(),
  ApiDoc({
    operationId: 'deleteAuthTrustedDevice',
    summary: 'Revoke a trusted device',
    description: 'Revoke a remembered device so the next login requires MFA again',
    tags: ['Auth'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    responses: {
      204: { description: 'Trusted device revoked' },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      404: { description: 'Device not found', schema: errorResponseSchema },
    },
  }),
  (req, res) => authController.revokeTrustedDevice(req, res),
);
router.post(
  '/refresh',
  ApiDoc({
    operationId: 'postAuthRefresh',
    summary: 'Refresh session token',
    description: 'Issue new tokens using a valid refresh cookie',
    tags: ['Auth'],
    responses: {
      200: { description: 'New tokens set in cookies', schema: successMessageSchema },
      401: { description: 'Invalid or expired refresh token', schema: errorResponseSchema },
    },
  }),
  (req, res) => authController.refresh(req, res)
);
router.post(
  '/logout',
  ApiDoc({
    operationId: 'postAuthLogout',
    summary: 'Log out',
    description: 'Invalidate current session and clear auth cookies',
    tags: ['Auth'],
    responses: {
      200: { description: 'Logged out', schema: successMessageSchema },
    },
  }),
  (req, res) => authController.logout(req, res)
);
router.get(
  '/csrf',
  ApiDoc({
    operationId: 'getAuthCsrf',
    summary: 'Get CSRF token',
    description:
      'Return the current CSRF double-submit token (creates one if missing). Needed for cross-origin SPAs.',
    tags: ['Auth'],
    responses: {
      200: {
        description: 'CSRF token',
        schema: {
          type: 'object',
          properties: { csrfToken: { type: 'string' } },
          required: ['csrfToken'],
        },
      },
    },
  }),
  (req, res) => authController.getCsrf(req, res)
);
router.get(
  '/sessions',
  Auth.user(),
  ApiDoc({
    operationId: 'getAuthSessions',
    summary: 'List active sessions',
    description: 'Get all sessions for the current user',
    tags: ['Auth'],
    security: ['bearerAuth'],
    responses: {
      200: { description: 'List of sessions', schema: sessionsListResponseSchema },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
    },
  }),
  (req, res) => authController.getSessions(req, res)
);
router.delete(
  '/sessions',
  Auth.user(),
  stepUpGrantService.requireStepUp('security'),
  ApiDoc({
    operationId: 'deleteAuthOtherSessions',
    summary: 'Revoke other sessions',
    description:
      'Revoke all active sessions except the current device. Requires recent step-up confirmation.',
    tags: ['Auth'],
    security: ['bearerAuth'],
    responses: {
      200: { description: 'Other sessions revoked', schema: successMessageSchema },
      400: { schema: errorResponseSchema },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      403: { schema: errorResponseSchema },
    },
  }),
  (req, res) => authController.revokeOtherSessions(req, res)
);
router.delete(
  '/sessions/:id',
  Auth.user(),
  ApiDoc({
    operationId: 'deleteAuthSession',
    summary: 'Revoke a session',
    description: 'Revoke a specific session by id',
    tags: ['Auth'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    responses: {
      200: { description: 'Session revoked', schema: successMessageSchema },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      404: { description: 'Session not found', schema: errorResponseSchema },
    },
  }),
  (req, res) => authController.revokeSession(req, res)
);

export default router;
