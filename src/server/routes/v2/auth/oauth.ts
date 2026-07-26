import {Router} from 'express';
import {OAuthController} from '@/server/controllers/oauth.js';
import {Auth} from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { errorResponseSchema, successMessageSchema } from '@/server/schemas/v2/auth/index.js';

const router: Router = Router();

router.post(
  '/callback/:provider',
  // Optional auth: login works without cookies; linking/reauth need req.user when present
  Auth.tryUser(),
  ApiDoc({
    operationId: 'postOAuthCallback',
    summary: 'OAuth callback',
    description: 'Handles OAuth provider callback (login, linking, or reauth).',
    tags: ['Auth'],
    params: { provider: { description: 'OAuth provider name', schema: { type: 'string' } } },
    responses: { 200: { description: 'Success' }, 302: { description: 'Redirect' }, 400: { schema: errorResponseSchema }, 500: { schema: errorResponseSchema } },
  }),
  OAuthController.handleCallback,
);

router.get('/me', Auth.user(), ApiDoc({
  operationId: 'getOAuthMe',
  summary: 'Get OAuth profile',
  description: 'Returns OAuth-linked profile for current user',
  tags: ['Auth'],
  security: ['bearerAuth'],
  responses: { 200: { description: 'Profile' }, 401: { schema: errorResponseSchema }, 500: { schema: errorResponseSchema } },
}), OAuthController.getProfile);

router.get('/login/:provider', OAuthController.initiateLogin);

router.get('/link/:provider', Auth.user(), ApiDoc({
  operationId: 'getOAuthLink',
  summary: 'Initiate OAuth link',
  description: 'Redirects to provider to link account (browser flow).',
  tags: ['Auth'],
  security: ['bearerAuth'],
  params: { provider: { schema: { type: 'string' } } },
  responses: { 200: { description: 'Auth URL' }, 401: { schema: errorResponseSchema } },
}), OAuthController.initiateLink);

router.get('/reauth/:provider', Auth.user(), ApiDoc({
  operationId: 'getOAuthReauth',
  summary: 'Initiate OAuth reauth for step-up',
  description: 'Redirects to provider to re-authenticate for sensitive actions',
  tags: ['Auth'],
  security: ['bearerAuth'],
  params: { provider: { schema: { type: 'string' } } },
  responses: { 200: { description: 'Auth URL' }, 401: { schema: errorResponseSchema } },
}), OAuthController.initiateReauth);

router.post(
  '/link/:provider',
  Auth.user(),
  ApiDoc({
    operationId: 'postOAuthLink',
    summary: 'Link OAuth provider',
    description: 'Complete linking after provider callback',
    tags: ['Auth'],
    security: ['bearerAuth'],
    params: { provider: { schema: { type: 'string' } } },
    responses: { 200: { schema: successMessageSchema }, 401: { schema: errorResponseSchema }, 500: { schema: errorResponseSchema } },
  }),
  OAuthController.linkProvider
);

router.post(
  '/unlink/:provider',
  Auth.user(),
  ApiDoc({
    operationId: 'postOAuthUnlink',
    summary: 'Unlink OAuth provider',
    description: 'Remove OAuth provider from account',
    tags: ['Auth'],
    security: ['bearerAuth'],
    params: { provider: { schema: { type: 'string' } } },
    responses: { 200: { schema: successMessageSchema }, 401: { schema: errorResponseSchema }, 500: { schema: errorResponseSchema } },
  }),
  OAuthController.unlinkProvider
);

export default router;
