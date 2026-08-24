import {Router, Request, Response} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {
  errorResponseSchema,
  standardErrorResponses401404500,
} from '@/server/schemas/common.js';
import {CacheInvalidation} from '@/server/middleware/cache.js';
import {handlePublicFollowsPatch} from '@/server/services/notifications/followHttp.js';

const router = Router();

router.patch(
  '/me/public',
  Auth.user(),
  ApiDoc({
    operationId: 'v3PatchFollowsMePublic',
    summary: 'Show or hide my follows on other people’s follower lists',
    description:
      'Account-wide preference. Body: `{ publicFollows: boolean }`. On by default. Also updates existing follow rows.',
    tags: ['Database', 'Follows', 'v3'],
    security: ['bearerAuth'],
    requestBody: {
      required: true,
      schema: {
        type: 'object',
        properties: {publicFollows: {type: 'boolean'}},
        required: ['publicFollows'],
      },
    },
    responses: {
      200: {
        description: 'Updated preference',
        schema: {
          type: 'object',
          properties: {publicFollows: {type: 'boolean'}},
        },
      },
      400: {schema: errorResponseSchema},
      ...standardErrorResponses401404500,
    },
  }),
  async (req: Request, res: Response) => {
    const result = await handlePublicFollowsPatch(req, res);
    if (result.statusCode === 200 && req.user?.id) {
      await CacheInvalidation.invalidateUser(req.user.id);
    }
    return result;
  },
);

export default router;
