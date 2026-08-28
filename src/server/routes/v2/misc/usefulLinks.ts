import {Router, Request, Response} from 'express';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {respondMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import {listSerializedLinks} from '@/server/services/usefulLinks/usefulLinkGroupService.js';
import {listSerializedTags} from '@/server/services/usefulLinks/usefulLinkTagService.js';

const router: Router = Router();

router.get(
  '/tags',
  ApiDoc({
    operationId: 'listUsefulLinkTags',
    summary: 'List useful link tags',
    tags: ['Misc'],
    responses: {200: {description: 'Admin-curated tags for filtering resources'}},
  }),
  async (_req: Request, res: Response) => {
    try {
      return res.json(await listSerializedTags());
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list useful link tags', {
        logLabel: 'List useful link tags failed:',
      });
    }
  },
);

router.get(
  '/',
  ApiDoc({
    operationId: 'listUsefulLinks',
    summary: 'List published catalog useful links',
    tags: ['Misc'],
    responses: {200: {description: 'Published catalog links with tags and locales'}},
  }),
  async (_req: Request, res: Response) => {
    try {
      return res.json(await listSerializedLinks({publishedOnly: true, catalogOnly: true}));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list useful links', {
        logLabel: 'List useful links failed:',
      });
    }
  },
);

export default router;
