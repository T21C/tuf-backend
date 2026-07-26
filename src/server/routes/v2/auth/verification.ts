import { Router } from 'express';
import { Auth } from '@/server/middleware/auth.js';
import { authController } from '@/server/controllers/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {
  errorResponseSchema,
  successMessageSchema,
} from '@/server/schemas/v2/auth/index.js';
import { stepUpGrantService } from '@/server/services/accounts/StepUpGrantService.js';

const router: Router = Router();

router.post(
  '/email',
  Auth.user(),
  ApiDoc({
    operationId: 'postAuthVerifyEmail',
    summary: 'Verify email with code',
    description: 'Confirm pending email using the code from the verification email',
    tags: ['Auth'],
    security: ['bearerAuth'],
    requestBody: {
      description: 'Verification code',
      schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
      required: true,
    },
    responses: {
      200: { schema: successMessageSchema },
      400: { schema: errorResponseSchema },
      500: { schema: errorResponseSchema },
    },
  }),
  authController.verifyEmail,
);

router.post(
  '/resend',
  Auth.user(),
  ApiDoc({
    operationId: 'postAuthResendVerification',
    summary: 'Resend verification email',
    description: 'Send a new verification code to the pending email',
    tags: ['Auth'],
    security: ['bearerAuth'],
    responses: {
      200: { schema: successMessageSchema },
      401: { schema: errorResponseSchema },
      500: { schema: errorResponseSchema },
    },
  }),
  authController.resendVerification,
);

router.post(
  '/change-email',
  Auth.user(),
  stepUpGrantService.requireStepUp('email-change'),
  ApiDoc({
    operationId: 'postAuthChangeEmail',
    summary: 'Request email change',
    description:
      'Set pending email and send verification code. Requires recent step-up authentication.',
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
      403: { schema: errorResponseSchema },
      429: { schema: errorResponseSchema },
      500: { schema: errorResponseSchema },
    },
  }),
  authController.changeEmail,
);

router.delete(
  '/pending-email',
  Auth.user(),
  ApiDoc({
    operationId: 'deleteAuthPendingEmail',
    summary: 'Cancel pending email',
    description: 'Clear pending email claim without changing the verified email',
    tags: ['Auth'],
    security: ['bearerAuth'],
    responses: {
      200: { schema: successMessageSchema },
      400: { schema: errorResponseSchema },
      401: { schema: errorResponseSchema },
      500: { schema: errorResponseSchema },
    },
  }),
  authController.cancelPendingEmail,
);

export default router;
