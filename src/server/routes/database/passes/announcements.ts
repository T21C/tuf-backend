import { Router, Request, Response } from 'express';
import { Op } from 'sequelize';
import { Auth } from '../../../middleware/auth.js';
import Pass from '../../../../models/passes/Pass.js';
import Player from '../../../../models/players/Player.js';
import Level from '../../../../models/levels/Level.js';
import Judgement from '../../../../models/passes/Judgement.js';
import Difficulty from '../../../../models/levels/Difficulty.js';
import { logger } from '../../../services/LoggerService.js';
import User from '../../../../models/auth/User.js';
import { permissionFlags } from '../../../../config/constants.js';
import { wherePermission } from '../../../../misc/utils/auth/permissionUtils.js';

const router = Router();


router.get('/unannounced/new', Auth.superAdmin(), async (req: Request, res: Response) => {
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
  });

export default router;
