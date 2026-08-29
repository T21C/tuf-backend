import {Router, Request, Response} from 'express';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {Cache} from '@/server/middleware/cache.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {respondMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import {PUBLIC_MODS_CACHE_TAG} from '@/server/services/mods/modCache.js';
import {
  parseModLimit,
  parseModOffset,
  parseModSearchQ,
  parseModSort,
} from '@/server/services/elasticsearch/search/mods/modSearchQuery.js';

const router: Router = Router();

router.get(
  '/',
  Cache({
    ttl: 300,
    prefix: 'mods:public',
    tags: [PUBLIC_MODS_CACHE_TAG],
  }),
  ApiDoc({
    operationId: 'listMods',
    summary: 'List public mods for the catalog page',
    tags: ['Misc'],
    responses: {200: {description: 'Public mods page'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const result = await ElasticsearchService.getInstance().searchMods({
        q: parseModSearchQ(req.query.q),
        offset: parseModOffset(req.query.offset),
        limit: parseModLimit(req.query.limit),
        sort: parseModSort(req.query.sort),
      });
      return res.json(result);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list mods', {
        logLabel: 'List mods failed:',
      });
    }
  },
);

export default router;
