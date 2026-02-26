import {Router} from 'express';
import {authController} from '@/server/controllers/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { errorResponseSchema, successMessageSchema, standardErrorResponses400500, standardErrorResponses500 } from '@/server/schemas/v2/auth/index.js';

const router: Router = Router();

router.post(
  '/request',
  ApiDoc({
    operationId: 'postAuthForgotPasswordRequest',
    summary: 'Request password reset',
    description: 'Send password reset email to the given email address',
    tags: ['Auth'],
    requestBody: { description: 'Email address', schema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] }, required: true },
    responses: { 200: { description: 'Email sent if account exists', schema: successMessageSchema }, 400: { schema: errorResponseSchema }, 500: { schema: errorResponseSchema } },
  }),
  authController.requestPasswordReset
);

router.post(
  '/reset',
  ApiDoc({
    operationId: 'postAuthForgotPasswordReset',
    summary: 'Reset password with token',
    description: 'Set new password using the token from the reset email',
    tags: ['Auth'],
    requestBody: { description: 'Token and new password', schema: { type: 'object', properties: { token: { type: 'string' }, newPassword: { type: 'string' } }, required: ['token', 'newPassword'] }, required: true },
    responses: { 200: { schema: successMessageSchema }, 400: { schema: errorResponseSchema }, 500: { schema: errorResponseSchema } },
  }),
  authController.resetPassword
);

export default router;
