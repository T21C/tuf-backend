import {Router, Request, Response} from 'express';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { logger } from '@/server/services/LoggerService.js';
import aliases from './aliases.js';
import modification from './modification.js';
import aprilFools from './aprilFools.js';
import announcements from './announcements.js';
import search from './search.js';
import packs from './packs.js';
import Level from '@/models/levels/Level.js';
import { hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import { permissionFlags } from '@/config/constants.js';

const router: Router = Router();

router.head(
  '/:id',
  ApiDoc({
    operationId: 'headLevelPermissionCheck',
    summary: 'Check level access',
    description: 'Returns 200 if level exists and user may access; 403/404 otherwise. No body.',
    tags: ['Levels'],
    params: { id: { description: 'Level ID', schema: { type: 'string' } } },
    responses: { 200: { description: 'OK' }, 400: { description: 'Invalid ID' }, 403: { description: 'Forbidden' }, 404: { description: 'Not found' }, 500: { description: 'Server error' } },
  }),
  async (req: Request, res: Response) => {
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
    if (level.isDeleted && (!req.user || !hasFlag(req.user, permissionFlags.SUPER_ADMIN))) {
      return res.status(403).end();
    }

    return res.status(200).end();
  } catch (error) {
    logger.error('Error checking level permissions:', error);
    return res.status(500).end();
  }
  }
);


router.use('/', aliases);
router.use('/', modification);
router.use('/', aprilFools);
router.use('/', announcements);
router.use('/', search);
router.use('/packs', packs);
export default router;
