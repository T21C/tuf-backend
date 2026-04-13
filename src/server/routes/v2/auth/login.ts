import {Router, Request, Response} from 'express';
import {OAuthController} from '@/server/controllers/oauth.js';
import {authController} from '@/server/controllers/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {
  loginRequestBodySchema,
  loginSuccessResponseSchema,
  loginErrorResponseSchema,
} from '@/server/schemas/auth.js';
import { logger } from '@/server/services/core/LoggerService.js';

const router: Router = Router();

router.post(
  '/',
  ApiDoc({
    operationId: 'postAuthLogin',
    summary: 'Log in',
    description: 'Authenticate with email/username and password; returns session cookies',
    tags: ['Auth'],
    requestBody: {
      description: 'Credentials and optional captcha',
      schema: loginRequestBodySchema,
      required: true,
    },
    responses: {
      200: { description: 'Login success', schema: loginSuccessResponseSchema },
      400: { description: 'Invalid credentials or captcha required', schema: loginErrorResponseSchema },
      500: { description: 'Server error', schema: loginErrorResponseSchema },
    },
  }),
  async (req: Request, res: Response) => {
    try {
      return await authController.login(req, res);
    } catch (error) {
      logger.error('Login error:', error);
      return res.status(500).json({error: 'Failed to login'});
    }
  }
);

// Login with OAuth provider
router.get('/:provider', OAuthController.initiateLogin);

export default router;
