import {Router, Request, Response} from 'express';
import { logger } from '../../../services/LoggerService.js';
import aliases from "./aliases.js";
import modification from "./modification.js";
import aprilFools from "./aprilFools.js";
import announcements from "./announcements.js";
import search from "./search.js";
import Level from '../../../models/levels/Level.js';

const router: Router = Router();

// Add HEAD endpoint for permission check
router.head('/:id', async (req: Request, res: Response) => {
  try {
    const levelId = parseInt(req.params.id);
    if (isNaN(levelId)) {
      return res.status(400).end();
    }

    const level = await Level.findOne({
      where: { id: levelId },
      attributes: ['isDeleted']
    });

    if (!level) {
      return res.status(404).end();
    }

    // If level is deleted and user is not super admin, return 403
    if (level.isDeleted && !req.user?.isSuperAdmin) {
      return res.status(403).end();
    }

    return res.status(200).end();
  } catch (error) {
    logger.error('Error checking level permissions:', error);
    return res.status(500).end();
  }
});


router.use('/', aliases);
router.use('/', modification);
router.use('/', aprilFools);
router.use('/', announcements);
router.use('/', search);
export default router;
