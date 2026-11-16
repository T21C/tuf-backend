import express, { Router, type Request, type Response } from 'express';

import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {
  errorResponseSchema,
  idParamSpec,
  standardErrorResponses500,
} from '@/server/schemas/v2/misc/index.js';
import { logger } from '@/server/services/core/LoggerService.js';

import { gateSubmission } from '../shared/submissionAuth.js';
import { sendFormError } from '../shared/errors.js';
import { getOwnedPassSubmission, updatePassSubmission } from './submissionService.js';

const router: Router = Router();

function parseSubmissionId(raw: string): number {
  const submissionId = Number.parseInt(raw, 10);
  if (!Number.isInteger(submissionId) || submissionId <= 0) {
    return 0;
  }
  return submissionId;
}

function isExpectedFormError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if (err instanceof Error && err.name === 'FormError') return true;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'number' && code >= 400 && code < 500) return true;
  return false;
}

router.get(
  '/:id([0-9]{1,20})',
  Auth.user(),
  ApiDoc({
    operationId: 'getFormPassSubmission',
    summary: 'Get own pass submission',
    description: 'Return a pass submission owned by the authenticated user, with judgements, flags, and assigned player.',
    tags: ['Form'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: {
      200: { description: 'Owned pass submission' },
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
      const submissionId = parseSubmissionId(req.params.id);
      if (!submissionId) {
        res.status(400).json({ error: 'Invalid submission id' });
        return;
      }

      const submission = await getOwnedPassSubmission(userId, submissionId);
      res.json({ submission });
    } catch (error) {
      if (!isExpectedFormError(error)) {
        logger.error('Failed to load pass submission:', { error, id: req.params.id });
      }
      sendFormError(res, error, 'Failed to load pass submission');
    }
  },
);

router.put(
  '/:id([0-9]{1,20})',
  Auth.user(),
  express.json(),
  ApiDoc({
    operationId: 'putFormPassSubmission',
    summary: 'Update own pending pass submission',
    description:
      'Replace a pending pass submission owned by the authenticated user. Upload time is stored as submitted. Only pending submissions can be edited.',
    tags: ['Form'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: {
      200: { description: 'Submission updated' },
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
      const submissionId = parseSubmissionId(req.params.id);
      if (!submissionId) {
        res.status(400).json({ error: 'Invalid submission id' });
        return;
      }

      const result = await updatePassSubmission({
        userId,
        submissionId,
        formPayload: (req.body ?? {}) as Record<string, unknown>,
      });
      res.json(result);
    } catch (error) {
      if (!isExpectedFormError(error)) {
        logger.error('Failed to update pass submission:', { error, id: req.params.id, body: req.body });
      }
      sendFormError(res, error, 'Failed to update pass submission');
    }
  },
);

export default router;
