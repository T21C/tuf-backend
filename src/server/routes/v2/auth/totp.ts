import {Router} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {errorResponseSchema, successMessageSchema} from '@/server/schemas/v2/auth/index.js';
import {stepUpGrantService} from '@/server/services/auth/StepUpGrantService.js';
import {totpController} from '@/server/controllers/totp.js';

const router: Router = Router();

router.post(
  '/setup',
  Auth.user(),
  stepUpGrantService.requireStepUp('security'),
  ApiDoc({
    operationId: 'postAuthTotpSetup',
    summary: 'Start authenticator setup',
    description:
      'Generate a TOTP secret and otpauth URI. When authenticator is already enabled, a current code is required to replace it.',
    tags: ['Auth'],
    security: ['bearerAuth'],
    requestBody: {
      description: 'Current authenticator or recovery code when replacing',
      schema: {
        type: 'object',
        properties: {
          code: {type: 'string'},
        },
      },
    },
    responses: {
      200: {description: 'Setup secret and otpauth URI'},
      400: {schema: errorResponseSchema},
      401: {schema: errorResponseSchema},
      403: {schema: errorResponseSchema},
      503: {schema: errorResponseSchema},
    },
  }),
  (req, res) => totpController.setup(req, res),
);

router.post(
  '/confirm',
  Auth.user(),
  stepUpGrantService.requireStepUp('security'),
  ApiDoc({
    operationId: 'postAuthTotpConfirm',
    summary: 'Confirm authenticator setup',
    description: 'Verify a code from the new authenticator, enable TOTP, and return recovery codes once',
    tags: ['Auth'],
    security: ['bearerAuth'],
    requestBody: {
      description: '6-digit authenticator code',
      schema: {
        type: 'object',
        properties: {
          code: {type: 'string'},
        },
        required: ['code'],
      },
      required: true,
    },
    responses: {
      200: {description: 'Recovery codes'},
      400: {schema: errorResponseSchema},
      401: {schema: errorResponseSchema},
      403: {schema: errorResponseSchema},
    },
  }),
  (req, res) => totpController.confirm(req, res),
);

router.post(
  '/recovery/regenerate',
  Auth.user(),
  stepUpGrantService.requireStepUp('security'),
  ApiDoc({
    operationId: 'postAuthTotpRecoveryRegenerate',
    summary: 'Regenerate recovery codes',
    description: 'Replace all authenticator recovery codes after verifying a current factor',
    tags: ['Auth'],
    security: ['bearerAuth'],
    requestBody: {
      description: 'Current authenticator or recovery code',
      schema: {
        type: 'object',
        properties: {
          code: {type: 'string'},
        },
        required: ['code'],
      },
      required: true,
    },
    responses: {
      200: {description: 'New recovery codes'},
      400: {schema: errorResponseSchema},
      401: {schema: errorResponseSchema},
      403: {schema: errorResponseSchema},
    },
  }),
  (req, res) => totpController.regenerateRecovery(req, res),
);

router.post(
  '/disable',
  Auth.user(),
  stepUpGrantService.requireStepUp('security'),
  ApiDoc({
    operationId: 'postAuthTotpDisable',
    summary: 'Disable authenticator',
    description: 'Turn off TOTP after verifying a current authenticator or recovery code',
    tags: ['Auth'],
    security: ['bearerAuth'],
    requestBody: {
      description: 'Current authenticator or recovery code',
      schema: {
        type: 'object',
        properties: {
          code: {type: 'string'},
        },
        required: ['code'],
      },
      required: true,
    },
    responses: {
      200: {description: 'Authenticator disabled', schema: successMessageSchema},
      400: {schema: errorResponseSchema},
      401: {schema: errorResponseSchema},
      403: {schema: errorResponseSchema},
    },
  }),
  (req, res) => totpController.disable(req, res),
);

export default router;
