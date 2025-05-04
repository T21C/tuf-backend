import { Op } from "sequelize";
import { Auth } from "../../../middleware/auth.js";
import Difficulty from "../../../models/levels/Difficulty.js";
import { sseManager } from "../../../utils/sse.js";
import Level from "../../../models/levels/Level.js";
import { Router, Request, Response } from "express";
import LevelCredit from "../../../models/levels/LevelCredit.js";
import Team from "../../../models/credits/Team.js";
import { logger } from "../../../services/LoggerService.js";

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
  
  // Mark levels as announced - single endpoint for all announcement operations
  router.post('/markAnnounced', Auth.superAdmin(), async (req: Request, res: Response) => {
    try {
      const {levelIds} = req.body;
  
      if (!Array.isArray(levelIds)) {
        return res.status(400).json({error: 'levelIds must be an array'});
      }
  
      await Level.update(
        {isAnnounced: true},
        {
          where: {
            id: {
              [Op.in]: levelIds,
            },
          },
        },
      );
  
      // Broadcast level update
      sseManager.broadcast({type: 'levelUpdate'});
  
      return res.json({success: true, message: 'Levels marked as announced'});
    } catch (error) {
      logger.error('Error marking levels as announced:', error);
      return res.status(500).json({error: 'Failed to mark levels as announced'});
    }
  });
  
  // Mark a single level as announced
  router.post('/markAnnounced/:id([0-9]+)', Auth.superAdmin(), async (req: Request, res: Response) => {
    try {
      const levelId = parseInt(req.params.id);
      if (isNaN(levelId)) {
        return res.status(400).json({error: 'Invalid level ID'});
      }
  
      const level = await Level.findByPk(levelId);
      if (!level) {
        return res.status(404).json({error: 'Level not found'});
      }
  
      await level.update({isAnnounced: true});
  
      // Broadcast level update
      sseManager.broadcast({type: 'levelUpdate'});
  
      return res.json({success: true});
    } catch (error) {
      logger.error('Error marking level as announced:', error);
      return res.status(500).json({
        error: 'Failed to mark level as announced',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });
  

  export default router;