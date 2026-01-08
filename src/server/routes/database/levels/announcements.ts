import { Op } from 'sequelize';
import { Auth } from '../../../../server/middleware/auth.js';
import Difficulty from '../../../../models/levels/Difficulty.js';
import Level from '../../../../models/levels/Level.js';
import { Router, Request, Response } from 'express';
import LevelCredit from '../../../../models/levels/LevelCredit.js';
import Team from '../../../../models/credits/Team.js';
import { logger } from '../../../../server/services/LoggerService.js';

// Get unannounced new levels
const router: Router = Router();

router.get('/unannounced/new', Auth.superAdmin(), async (req: Request, res: Response) => {
    try {
      const levels = await Level.findAll({
        where: {
          isAnnounced: false,
          diffId: {
            [Op.ne]: 0,
          },
          previousDiffId: {
            [Op.or]: [{[Op.eq]: 0}],
          },
          isDeleted: false,
        },
        include: [
          {
            model: Difficulty,
            as: 'difficulty',
          },
        ],
        order: [['createdAt', 'DESC']],
      });

      return res.json(levels);
    } catch (error) {
      logger.error('Error fetching unannounced new levels:', error);
      return res
        .status(500)
        .json({error: 'Failed to fetch unannounced new levels'});
    }
  });

  // Get unannounced rerates
  router.get('/unannounced/rerates', Auth.superAdmin(), async (req: Request, res: Response) => {
    try {
      const levels = await Level.findAll({
        where: {
          isAnnounced: false,
          diffId: {
            [Op.ne]: 0,
          },
          previousDiffId: {
            [Op.and]: [{[Op.ne]: 0}],
          },
          isDeleted: false,
        },
        include: [
          {
            model: Difficulty,
            as: 'difficulty',
          },
          {
            model: Difficulty,
            as: 'previousDifficulty',
          },
          {
            model: LevelCredit,
            as: 'levelCredits',
          },
          {
            model: Team,
            as: 'teamObject',
          },
        ],
        order: [['updatedAt', 'DESC']],
      });

      return res.json(levels);
    } catch (error) {
      logger.error('Error fetching unannounced rerates:', error);
      return res.status(500).json({error: 'Failed to fetch unannounced rerates'});
    }
  });

  export default router;
