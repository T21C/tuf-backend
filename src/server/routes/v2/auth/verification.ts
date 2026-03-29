import {Router} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {authController} from '@/server/controllers/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { errorResponseSchema, successMessageSchema, standardErrorResponses400500, standardErrorResponses500 } from '@/server/schemas/v2/auth/index.js';

const router: Router = Router();

router.post(
  '/email',
  ApiDoc({
    operationId: 'postAuthVerifyEmail',
    summary: 'Verify email',
    description: 'Verify email address using token from verification email',
    tags: ['Auth'],
    requestBody: { description: 'Token', schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] }, required: true },
    responses: { 200: { schema: successMessageSchema }, 400: { schema: errorResponseSchema }, 500: { schema: errorResponseSchema } },
  }),
  authController.verifyEmail
);

router.post(
  '/resend',
  Auth.user(),
  ApiDoc({
    operationId: 'postAuthResendVerification',
    summary: 'Resend verification email',
    description: 'Send a new verification email to the current user',
    tags: ['Auth'],
    security: ['bearerAuth'],
    responses: { 200: { schema: successMessageSchema }, 401: { schema: errorResponseSchema }, 500: { schema: errorResponseSchema } },
  }),
  authController.resendVerification
);

router.post(
  '/change-email',
  Auth.user(),
  ApiDoc({
    operationId: 'postAuthChangeEmail',
    summary: 'Change account email',
    description: 'Change authenticated user email and send a new verification email',
    tags: ['Auth'],
    security: ['bearerAuth'],
    requestBody: {
      description: 'New email',
      schema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
      required: true,
    },
    responses: {
      200: { schema: successMessageSchema },
      400: { schema: errorResponseSchema },
      401: { schema: errorResponseSchema },
      429: { schema: errorResponseSchema },
      500: { schema: errorResponseSchema },
    },
  }),
  authController.changeEmail
);

export default router;
