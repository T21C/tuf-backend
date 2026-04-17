import { Router, type Request, type Response } from 'express';

import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {
  errorResponseSchema,
  standardErrorResponses500,
} from '@/server/schemas/v2/misc/index.js';
import { logger } from '@/server/services/core/LoggerService.js';

import { gateSubmission } from '../shared/submissionAuth.js';
import { sendFormError, formError } from '../shared/errors.js';
import { safeParseJSON } from '../shared/json.js';
import {
  evidenceMultipart,
  cleanupEvidenceTempfiles,
} from '../shared/evidenceMultipart.js';
import { createLevelSubmission } from './submissionService.js';

const router: Router = Router();

/**
 * Payload shape: multipart/form-data with
 *   - `meta` (text): JSON-encoded form fields + optional `uploadSessionId`
 *   - `evidence[]` (files): 0-10 image files, 10 MB max each
 *
 * The zip file itself never passes through multer — it arrives via the chunked
 * upload system (`/v2/upload`) and is referenced here by `uploadSessionId`.
 */
router.post(
  '/submit',
  Auth.user(),
  evidenceMultipart,
  ApiDoc({
    operationId: 'postFormLevelSubmit',
    summary: 'Create a level submission',
    description:
      'Multipart: meta JSON (form fields + optional uploadSessionId) + up to 10 evidence images. Large level zips go through /v2/upload.',
    tags: ['Form'],
    security: ['bearerAuth'],
    responses: {
      200: { description: 'Submission created' },
      400: { schema: errorResponseSchema },
      401: { schema: errorResponseSchema },
      403: { schema: errorResponseSchema },
      404: { schema: errorResponseSchema },
      409: { schema: errorResponseSchema },
      ...standardErrorResponses500,
    },
  }),
  async (req: Request, res: Response) => {
    const evidenceFiles = (req.files as Express.Multer.File[] | undefined) ?? [];
    try {
      const { userId } = gateSubmission(req);

      const metaRaw = req.body?.meta;
      const parsedMeta = safeParseJSON<Record<string, unknown>>(
        metaRaw as string | object | null | undefined,
      );
      if (!parsedMeta || typeof parsedMeta !== 'object') {
        throw formError.bad('Missing or invalid `meta` field (JSON-encoded form payload)', {
          field: 'meta',
        });
      }

      const uploadSessionIdRaw = parsedMeta.uploadSessionId;
      const uploadSessionId =
        typeof uploadSessionIdRaw === 'string' && uploadSessionIdRaw.length > 0
          ? uploadSessionIdRaw
          : null;

      const result = await createLevelSubmission({
        req,
        userId,
        formPayload: parsedMeta,
        uploadSessionId,
        evidenceFiles,
      });

      res.json(result);
      return;
    } catch (error) {
      if (!isExpectedFormError(error)) {
        logger.error('Level submission failed:', { error, body: req.body });
      }
      sendFormError(res, error, 'Failed to create level submission');
    } finally {
      await cleanupEvidenceTempfiles(evidenceFiles);
    }
  },
);

function isExpectedFormError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'number' && code >= 400 && code < 500) return true;
  if (err instanceof Error && err.name === 'FormError') {
    const status = (err as unknown as { code: number }).code;
    return status >= 400 && status < 500;
  }
  return false;
}

export default router;
