import express, { Router, type Request, type Response } from 'express';

import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {
  errorResponseSchema,
  standardErrorResponses500,
} from '@/server/schemas/v2/misc/index.js';
import { logger } from '@/server/services/core/LoggerService.js';

import { gateSubmission } from '../shared/submissionAuth.js';
import { sendFormError } from '../shared/errors.js';
import { createPassSubmission } from './submissionService.js';

const router: Router = Router();

router.post(
  '/submit',
  Auth.user(),
  express.json(),
  ApiDoc({
    operationId: 'postFormPassSubmit',
    summary: 'Create a pass submission',
    description: 'JSON-only pass submission; no files, no multer.',
    tags: ['Form'],
    security: ['bearerAuth'],
    responses: {
      200: { description: 'Submission created' },
      400: { schema: errorResponseSchema },
      401: { schema: errorResponseSchema },
      403: { schema: errorResponseSchema },
      404: { schema: errorResponseSchema },
      ...standardErrorResponses500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const { userId } = gateSubmission(req);

      const result = await createPassSubmission({
        req,
        userId,
        formPayload: (req.body ?? {}) as Record<string, unknown>,
      });

      res.json(result);
      return;
    } catch (error) {
      if (!isExpectedFormError(error)) {
        logger.error('Pass submission failed:', { error, body: req.body });
      }
      sendFormError(res, error, 'Failed to create pass submission');
    }
  },
);

function isExpectedFormError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'number' && code >= 400 && code < 500) return true;
  return false;
}

export default router;
