import {Router} from 'express';
import {OAuthController} from '@/server/controllers/oauth.js';
import {Auth} from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { errorResponseSchema, successMessageSchema, standardErrorResponses400500, standardErrorResponses404500, standardErrorResponses500, stringIdParamSpec } from '@/server/schemas/v2/auth/index.js';

const router: Router = Router();

router.post(
  '/callback/:provider',
  ApiDoc({
    operationId: 'postOAuthCallback',
    summary: 'OAuth callback',
    description: 'Handles OAuth provider callback (used by provider redirect).',
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

// Initiate OAuth login (redirects to provider – no Try it out)
router.get('/login/:provider', OAuthController.initiateLogin);

router.get('/link/:provider', Auth.user(), ApiDoc({
  operationId: 'getOAuthLink',
  summary: 'Initiate OAuth link',
  description: 'Redirects to provider to link account (browser flow).',
  tags: ['Auth'],
  security: ['bearerAuth'],
  params: { provider: { schema: { type: 'string' } } },
  responses: { 302: { description: 'Redirect to provider' }, 401: { schema: errorResponseSchema } },
}), OAuthController.initiateLink);

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
