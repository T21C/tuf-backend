import {Router} from 'express';
import {authController} from '@/server/controllers/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { standardErrorResponses400500 } from '@/server/schemas/v2/auth/index.js';
import { loginSuccessResponseSchema, loginErrorResponseSchema } from '@/server/schemas/auth.js';

const router: Router = Router();

router.post(
  '/',
  ApiDoc({
    operationId: 'postAuthRegister',
    summary: 'Register',
    description: 'Create a new user account',
    tags: ['Auth'],
    requestBody: { description: 'Username, email, password, etc.', schema: { type: 'object', properties: { username: { type: 'string' }, email: { type: 'string' }, password: { type: 'string' } }, required: ['username', 'email', 'password'] }, required: true },
    responses: { 200: { description: 'Registered; may return session', schema: loginSuccessResponseSchema }, 400: { schema: loginErrorResponseSchema }, 500: { schema: loginErrorResponseSchema } },
  }),
  authController.register
);

export default router;
