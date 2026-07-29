import { Router } from 'express';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {
  successMessageSchema,
  errorResponseSchema,
  stringIdParamSpec,
} from '@/server/schemas/v2/auth/index.js';
import { stepUpGrantService } from '@/server/services/auth/StepUpGrantService.js';
import { passkeyController } from '@/server/controllers/passkeys.js';

const router: Router = Router();

router.post(
  '/register/options',
  Auth.user(),
  stepUpGrantService.requireStepUp('security'),
  ApiDoc({
    operationId: 'postAuthPasskeysRegisterOptions',
    summary: 'Begin passkey registration',
    description: 'Return WebAuthn PublicKeyCredentialCreationOptions for the current user',
    tags: ['Auth', 'Passkeys'],
    security: ['bearerAuth'],
    responses: {
      200: { description: 'Registration options' },
      401: { schema: errorResponseSchema },
      403: { schema: errorResponseSchema },
    },
  }),
  (req, res) => passkeyController.registerOptions(req, res),
);

router.post(
  '/register/verify',
  Auth.user(),
  stepUpGrantService.requireStepUp('security'),
  ApiDoc({
    operationId: 'postAuthPasskeysRegisterVerify',
    summary: 'Finish passkey registration',
    description: 'Verify the WebAuthn attestation and store the new credential',
    tags: ['Auth', 'Passkeys'],
    security: ['bearerAuth'],
    requestBody: {
      description: 'Registration response and optional display name',
      schema: {
        type: 'object',
        properties: {
          response: { type: 'object' },
          name: { type: 'string' },
        },
        required: ['response'],
      },
      required: true,
    },
    responses: {
      201: { description: 'Passkey registered', schema: successMessageSchema },
      400: { schema: errorResponseSchema },
      401: { schema: errorResponseSchema },
      403: { schema: errorResponseSchema },
    },
  }),
  (req, res) => passkeyController.registerVerify(req, res),
);

router.get(
  '/',
  Auth.user(),
  ApiDoc({
    operationId: 'getAuthPasskeys',
    summary: 'List passkeys',
    description: 'Passkeys registered on the current account',
    tags: ['Auth', 'Passkeys'],
    security: ['bearerAuth'],
    responses: {
      200: { description: 'Passkey list' },
      401: { schema: errorResponseSchema },
    },
  }),
  (req, res) => passkeyController.list(req, res),
);

router.patch(
  '/:id',
  Auth.user(),
  ApiDoc({
    operationId: 'patchAuthPasskey',
    summary: 'Rename a passkey',
    tags: ['Auth', 'Passkeys'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    requestBody: {
      description: 'New display name',
      schema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      required: true,
    },
    responses: {
      200: { description: 'Passkey renamed' },
      400: { schema: errorResponseSchema },
      401: { schema: errorResponseSchema },
      404: { schema: errorResponseSchema },
    },
  }),
  (req, res) => passkeyController.rename(req, res),
);

router.delete(
  '/:id',
  Auth.user(),
  stepUpGrantService.requireStepUp('security'),
  ApiDoc({
    operationId: 'deleteAuthPasskey',
    summary: 'Remove a passkey',
    tags: ['Auth', 'Passkeys'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    responses: {
      204: { description: 'Passkey removed' },
      401: { schema: errorResponseSchema },
      403: { schema: errorResponseSchema },
      404: { schema: errorResponseSchema },
    },
  }),
  (req, res) => passkeyController.remove(req, res),
);

router.post(
  '/login/options',
  ApiDoc({
    operationId: 'postAuthPasskeysLoginOptions',
    summary: 'Begin usernameless passkey login',
    description: 'Return WebAuthn PublicKeyCredentialRequestOptions with empty allowCredentials',
    tags: ['Auth', 'Passkeys'],
    responses: {
      200: { description: 'Authentication options' },
      429: { schema: errorResponseSchema },
    },
  }),
  (req, res) => passkeyController.loginOptions(req, res),
);

router.post(
  '/login/verify',
  ApiDoc({
    operationId: 'postAuthPasskeysLoginVerify',
    summary: 'Finish usernameless passkey login',
    description: 'Verify the assertion (UV required) and issue a session',
    tags: ['Auth', 'Passkeys'],
    requestBody: {
      description: 'Authentication response',
      schema: {
        type: 'object',
        properties: { response: { type: 'object' } },
        required: ['response'],
      },
      required: true,
    },
    responses: {
      200: { description: 'Session issued', schema: successMessageSchema },
      400: { schema: errorResponseSchema },
      403: { schema: errorResponseSchema },
      404: { schema: errorResponseSchema },
      429: { schema: errorResponseSchema },
    },
  }),
  (req, res) => passkeyController.loginVerify(req, res),
);

export default router;
