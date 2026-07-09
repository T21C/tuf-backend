import {Router, Request, Response} from 'express';
import Level from '@/models/levels/Level.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {PlacementUtilizationService} from '@/server/services/tournaments/PlacementUtilizationService.js';

const router = Router();
const placementService = PlacementUtilizationService.getInstance();

router.get(
  '/:id([0-9]{1,20})/tournament-appearances',
  async (req: Request, res: Response) => {
    try {
      const levelId = parseInt(req.params.id, 10);
      if (!Number.isFinite(levelId)) {
        return res.status(400).json({error: 'Invalid level ID'});
      }

      const level = await Level.findByPk(levelId, {
        attributes: ['id'],
      });
      if (!level) {
        return res.status(404).json({error: 'Level not found'});
      }

      const appearances = await placementService.getAppearancesForLevel(levelId);
      return res.json({appearances});
    } catch (error) {
      logger.error('Error fetching level tournament appearances:', error);
      return res.status(500).json({error: 'Failed to fetch tournament appearances'});
    }
  },
);

export default router;
