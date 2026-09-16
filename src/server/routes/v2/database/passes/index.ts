import {Router} from 'express';
import { logger } from '@/server/services/core/LoggerService.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';

const elasticsearchService = ElasticsearchService.getInstance();
const router: Router = Router();

export { updateWorldsFirstStatus, updateWorldsFirstPPStatus, updateWorldsFirstFlags } from '@/server/services/passes/worldsFirst.js';

export async function searchPasses(query: any, userPlayerId?: number, isSuperAdmin = false) {
  try {
      const startTime = Date.now();
      const { hits, total } = await elasticsearchService.searchPasses(query.query, {
        deletedFilter: query.deletedFilter,
        minDiff: query.minDiff,
        maxDiff: query.maxDiff,
        keyFlag: query.keyFlag,
        wfFilter: query.wfFilter,
        adofaiVersionFilter: query.adofaiVersionFilter,
        specialDifficulties: query.specialDifficulties,
        sort: query.sort,
        seed: query.seed,
        offset: query.offset,
        limit: query.limit
      }, userPlayerId, isSuperAdmin);

      const duration = Date.now() - startTime;
      if (duration > 1000) {
        logger.debug(`[Passes] Search completed in ${duration}ms with ${total} results`);
      }

      return {
        count: total,
        results: hits
      };
    }
    catch (error) {
    logger.error('Error in unified pass search:', error);
    throw error;
  }
}

import announcements from './announcements.js';
import modification from './modification.js';
import search from './search.js';

router.use('/', announcements);
router.use('/', modification);
router.use('/', search);

export default router;



