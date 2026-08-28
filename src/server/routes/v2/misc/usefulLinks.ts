import {Router, Request, Response} from 'express';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {Cache} from '@/server/middleware/cache.js';
import {respondMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import {listResourcesCatalog} from '@/server/services/usefulLinks/usefulLinkGroupService.js';
import {PUBLIC_LINKS_CACHE_TAG} from '@/server/services/usefulLinks/usefulLinkCache.js';

const router: Router = Router();

router.get(
  '/',
  Cache({
    ttl: 300,
    prefix: 'resources:links',
    tags: [PUBLIC_LINKS_CACHE_TAG],
  }),
  ApiDoc({
    operationId: 'listUsefulLinks',
    summary: 'List useful links grouped for the public resources page',
    tags: ['Misc'],
    responses: {200: {description: 'Groups with ordered link ids and all links'}},
  }),
  async (_req: Request, res: Response) => {
    try {
      return res.json(await listResourcesCatalog());
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list useful links', {
        logLabel: 'List useful links failed:',
      });
    }
  },
);

export default router;
