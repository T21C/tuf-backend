import {Router, Request, Response} from 'express';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {respondMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import {listSerializedLinks} from '@/server/services/usefulLinks/usefulLinkGroupService.js';

const router: Router = Router();

router.get(
  '/',
  ApiDoc({
    operationId: 'listUsefulLinks',
    summary: 'List published useful links',
    tags: ['Misc'],
    responses: {200: {description: 'Published links ordered by group then sort weight'}},
  }),
  async (_req: Request, res: Response) => {
    try {
      return res.json(await listSerializedLinks({publishedOnly: true}));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list useful links', {
        logLabel: 'List useful links failed:',
      });
    }
  },
);

export default router;
