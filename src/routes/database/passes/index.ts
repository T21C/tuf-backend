import Pass from '../../../models/passes/Pass.js';
import Level from '../../../models/levels/Level.js';
import Player from '../../../models/players/Player.js';
import User from '../../../models/auth/User.js';
import {Router} from 'express';
import { logger } from '../../../services/LoggerService.js';
import ElasticsearchService from '../../../services/ElasticsearchService.js';
import { wherePermission } from '../../../utils/permissionUtils.js';
import { permissionFlags } from '../../../config/constants.js';
import { Op } from 'sequelize';

const elasticsearchService = ElasticsearchService.getInstance();
const router: Router = Router();

export async function updateWorldsFirstStatus(
  levelId: number,
  transaction?: any,
) {
  // Find the earliest non-deleted pass for this level from non-banned players
  const earliestPass = await Pass.findOne({
    where: {
      levelId,
      isDeleted: false
    },
    include: [
      {
        model: Player,
        as: 'player',
        required: true,
        include: [
          {
            model: User,
            as: 'user',
            required: false,
            where: {
              [Op.and]: [
                wherePermission(permissionFlags.BANNED, false)
              ]
            }
          }
        ]
      },
      {
        model: Level,
        as: 'level',
        where: {
          isDeleted: false,
          isHidden: false
        },
        required: true
      }
    ],
    order: [['vidUploadTime', 'ASC']],
    transaction,
  });

  // Reset all passes for this level to not be world's first
  await Pass.update(
    {isWorldsFirst: false},
    {
      where: {levelId},
      transaction,
    },
  );

  // If we found an earliest pass, mark it as world's first
  if (earliestPass) {
    await Pass.update(
      {isWorldsFirst: true},
      {
        where: {id: earliestPass.id},
        transaction,
      },
    );
  }
}

export async function searchPasses(query: any) {
  try {
      const startTime = Date.now();
      const { hits, total } = await elasticsearchService.searchPasses(query.query, {
        deletedFilter: query.deletedFilter,
        minDiff: query.minDiff,
        maxDiff: query.maxDiff,
        keyFlag: query.keyFlag,
        specialDifficulties: query.specialDifficulties,
        sort: query.sort,
        offset: query.offset,
        limit: query.limit
      });

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



