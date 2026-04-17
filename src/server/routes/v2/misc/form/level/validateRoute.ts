import { Router, type Request, type Response } from 'express';
import express from 'express';

import sequelize from '@/config/db.js';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {
  errorResponseSchema,
  standardErrorResponses500,
} from '@/server/schemas/v2/misc/index.js';
import { safeTransactionRollback } from '@/misc/utils/Utility.js';

import { gateSubmission } from '../shared/submissionAuth.js';
import { sendFormError, formError } from '../shared/errors.js';
import { parseAndSanitizeLevelForm } from './dto.js';
import { computeEvidenceRequirements, validateLevelReferences } from './referenceCheck.js';
import { assertNoDuplicateLevelSubmission } from './duplicateCheck.js';

const router: Router = Router();

/**
 * Pure validation endpoint — no side effects, no uploads. Returns the
 * sanitised payload plus an `upload` hint so the client knows whether it
 * should run the chunked-upload step before calling `/submit`.
 *
 * The same checks run again inside `/submit` so skipping this endpoint is
 * still safe; it only exists to give the client fast, per-field feedback
 * before sending gigabytes over the wire.
 */
router.post(
  '/validate',
  Auth.user(),
  express.json(),
  ApiDoc({
    operationId: 'postFormLevelValidate',
    summary: 'Validate a level submission payload',
    description: 'Pure validation: auth gate + structural checks + reference + duplicate check. Zero side effects.',
    tags: ['Form'],
    security: ['bearerAuth'],
    responses: {
      200: { description: 'Payload is valid' },
      400: { schema: errorResponseSchema },
      401: { schema: errorResponseSchema },
      403: { schema: errorResponseSchema },
      409: { schema: errorResponseSchema },
      ...standardErrorResponses500,
    },
  }),
  async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      const { userId } = gateSubmission(req);

      const { sanitized, errors } = parseAndSanitizeLevelForm(req.body ?? {});
      if (errors.length > 0) {
        throw formError.bad('Invalid level submission payload', {
          details: { fields: errors },
        });
      }

      await validateLevelReferences(sanitized, transaction);
      await assertNoDuplicateLevelSubmission(sanitized, userId, transaction);
      const evidenceRequirements = await computeEvidenceRequirements(sanitized, transaction);

      await transaction.commit();

      return res.json({
        ok: true,
        sanitized,
        evidence: evidenceRequirements,
        upload: { kind: 'level-zip' },
      });
    } catch (error) {
      await safeTransactionRollback(transaction);
      sendFormError(res, error, 'Failed to validate submission');
      return;
    }
  },
);

export default router;
