import {Router, Request, Response} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {respondMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import {runArtistVerificationSync} from '@/server/services/artists/artistVerificationSync.js';

const router: Router = Router();

router.post(
  '/sync',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminSyncArtistVerification',
    summary: 'Fetch the 7BG artist list and upsert source-aligned verification states and extra info',
    tags: ['Admin', 'Artists'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Sync result'}},
  }),
  async (_req: Request, res: Response) => {
    try {
      const result = await runArtistVerificationSync();
      return res.json(result);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to sync artist verification', {
        logLabel: 'Admin sync artist verification failed:',
      });
    }
  },
);

export default router;
