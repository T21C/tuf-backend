import { Router, Request, Response } from 'express';
import { Op } from 'sequelize';
import { Auth } from '../../../middleware/auth.js';
import Pass from '../../../models/passes/Pass.js';
import Player from '../../../models/players/Player.js';
import Level from '../../../models/levels/Level.js';
import Judgement from '../../../models/passes/Judgement.js';
import Difficulty from '../../../models/levels/Difficulty.js';
import { logger } from '../../../services/LoggerService.js';

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
            where: {isBanned: false},
            required: true,
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
  
  // Mark passes as announced
  router.post('/markAnnounced', Auth.superAdmin(), async (req: Request, res: Response) => {
    try {
      const {passIds} = req.body;
  
      if (
        !Array.isArray(passIds) ||
        !passIds.every(id => Number.isInteger(id) && id > 0)
      ) {
        return res
          .status(400)
          .json({error: 'passIds must be an array of valid IDs'});
      }
  
      await Pass.update(
        {isAnnounced: true},
        {
          where: {
            id: {
              [Op.in]: passIds,
            },
            isDeleted: false,
          },
        },
      );
  
      return res.json({success: true, message: 'Passes marked as announced'});
    } catch (error) {
      logger.error('Error marking passes as announced:', error);
      return res.status(500).json({error: 'Failed to mark passes as announced'});
    }
  });
  
  // Mark a single pass as announced
  router.post('/markAnnounced/:id([0-9]+)', Auth.superAdmin(), async (req: Request, res: Response) => {
    try {
      const passId = parseInt(req.params.id);
      if (!passId || isNaN(passId) || passId <= 0) {
        return res.status(400).json({error: 'Invalid pass ID'});
      }
  
      const pass = await Pass.findOne({
        where: {
          id: passId,
          isDeleted: false,
        },
      });
  
      if (!pass) {
        return res.status(404).json({error: 'Pass not found'});
      }
  
      await pass.update({isAnnounced: true});
      return res.json({success: true});
    } catch (error) {
      logger.error('Error marking pass as announced:', error);
      return res.status(500).json({
        error: 'Failed to mark pass as announced',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

export default router;
