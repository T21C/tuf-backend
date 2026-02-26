import { Router, Request, Response } from 'express';
import { Op } from 'sequelize';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { standardErrorResponses500 } from '@/server/schemas/v2/database/passes/index.js';
import Pass from '@/models/passes/Pass.js';
import Player from '@/models/players/Player.js';
import Level from '@/models/levels/Level.js';
import Judgement from '@/models/passes/Judgement.js';
import Difficulty from '@/models/levels/Difficulty.js';
import { logger } from '@/server/services/LoggerService.js';
import User from '@/models/auth/User.js';

const router = Router();


router.get(
  '/unannounced/new',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'getUnannouncedPasses',
    summary: 'List unannounced passes',
    description: 'List passes that are not yet announced (isAnnounced: false, non-deleted, non-deleted level, ranked difficulty). Super admin only.',
    tags: ['Passes'],
    security: ['bearerAuth'],
    responses: { 200: { description: 'Array of unannounced passes' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const passes = await Pass.findAll({
        where: {
          isAnnounced: false,
          isDeleted: false
        },
        include: [
          {
            model: Player,
            as: 'player',
            attributes: ['name', 'country', 'isBanned'],
            required: true,
            where: {
              isBanned: false
            },
            include: [
              {
                model: User,
                as: 'user',
                required: false,
              }
            ]
          },
          {
            model: Level,
            as: 'level',
            required: true,
            where: {
              isDeleted: false,
              isHidden: false
            },
            include: [
              {
                model: Difficulty,
                as: 'difficulty',
                required: true,
                where: {
                  [Op.not]: {
                    name: 'Unranked'
                  }
                }
              },
            ],
          },
          {
            model: Judgement,
            as: 'judgements',
            required: false,
          },
        ],
        order: [['updatedAt', 'DESC']],
      });

      return res.json(passes);
    } catch (error) {
      logger.error('Error fetching unannounced passes:', error);
      return res.status(500).json({error: 'Failed to fetch unannounced passes'});
    }
  },
);

export default router;
