import {Router, Request, Response} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {
  errorResponseSchema,
  standardErrorResponses401404500,
} from '@/server/schemas/common.js';
import {CacheInvalidation} from '@/server/middleware/cache.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {
  ClientPreferenceError,
} from '@/server/services/auth/clientPreferencePayload.js';
import {patchClientPreferences} from '@/server/services/auth/ClientPreferenceService.js';

const router = Router();

router.patch(
  '/me',
  Auth.user(),
  ApiDoc({
    operationId: 'v3PatchPreferencesMe',
    summary: 'Update account client preferences',
    description:
      'Shallow-merge allowlisted client UX flags onto the current user. Sticky dismiss keys can only be set true. Body is a partial object of known keys.',
    tags: ['Profile', 'v3'],
    security: ['bearerAuth'],
    requestBody: {
      required: true,
      schema: {
        type: 'object',
        additionalProperties: true,
      },
    },
    responses: {
      200: {
        description: 'Merged preferences',
        schema: {
          type: 'object',
          properties: {
            clientPreferences: {type: 'object'},
          },
        },
      },
      400: {schema: errorResponseSchema},
      ...standardErrorResponses401404500,
    },
  }),
  async (req: Request, res: Response) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({error: 'User not authenticated'});
    }
    try {
      const clientPreferences = await patchClientPreferences(userId, req.body);
      await CacheInvalidation.invalidateUser(userId);
      return res.json({clientPreferences});
    } catch (error) {
      if (error instanceof ClientPreferenceError) {
        return res.status(error.status).json({error: error.message});
      }
      logger.error('Error updating client preferences:', error);
      return res.status(500).json({error: 'Failed to update preferences'});
    }
  },
);

export default router;
