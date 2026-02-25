import {Router} from 'express';
import loginRoutes from './login.js';
import registerRoutes from './register.js';
import verificationRoutes from './verification.js';
import oauthRoutes from './oauth.js';
import profileRoutes from '@/server/routes/v2/profile/profile.js';
import forgotPasswordRoutes from './forgotPassword.js';
import { authController } from '@/server/controllers/auth.js';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {
  successMessageSchema,
  errorResponseSchema,
  sessionsListResponseSchema,
} from '@/server/schemas/index.js';

const router: Router = Router();

router.use('/login', loginRoutes);
router.use('/register', registerRoutes);
router.use('/verify', verificationRoutes);
router.use('/oauth', oauthRoutes);
router.use('/profile', profileRoutes);
router.use('/forgot-password', forgotPasswordRoutes);
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
  '/sessions/:id',
  Auth.user(),
  ApiDoc({
    operationId: 'deleteAuthSession',
    summary: 'Revoke a session',
    description: 'Revoke a specific session by id',
    tags: ['Auth'],
    security: ['bearerAuth'],
    params: { id: { description: 'Session ID', schema: { type: 'string' } } },
    responses: {
      200: { description: 'Session revoked', schema: successMessageSchema },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      404: { description: 'Session not found', schema: errorResponseSchema },
    },
  }),
  (req, res) => authController.revokeSession(req, res)
);

export default router;
