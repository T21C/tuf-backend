import { Router } from 'express';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { errorResponseSchema, successMessageSchema, standardErrorResponses500 } from '@/server/schemas/v2/misc/index.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { AutoraterError, autoraterService } from '@/server/services/data/AutoraterService.js';

const router = Router();

router.post(
  '/autorate/:ratingId([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'postExternalAutorate',
    summary: 'Trigger autorate',
    description: 'Trigger external autorater for a rating (super admin)',
    tags: ['Admin', 'External'],
    security: ['bearerAuth'],
    params: { ratingId: { schema: { type: 'string' } } },
    responses: { 200: { schema: successMessageSchema }, 400: { schema: errorResponseSchema }, 404: { schema: errorResponseSchema }, ...standardErrorResponses500 },
  }),
  async (req, res) => {
    try {
      const ratingId = parseInt(req.params.ratingId);
      const result = await autoraterService.autorateRating(ratingId);

      return res.json({
        response: result.response,
        message: 'Level autorated successfully',
      });
    } catch (error) {
      if (error instanceof AutoraterError) {
        const body: Record<string, unknown> = { error: error.message };
        if (error.detail !== undefined) {
          if (typeof error.detail === 'string') {
            body.detail = error.detail;
          } else {
            body.response = error.detail;
          }
        }
        return res.status(error.statusCode).json(body);
      }
      logger.error('Error autorating level:', error);
      return res.status(500).json({ error: 'Failed to autorate level' });
    }
  },
);

export default router;
