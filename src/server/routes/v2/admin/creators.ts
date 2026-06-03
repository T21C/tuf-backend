import {Router, Request, Response} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {
  standardErrorResponses404500,
  idParamSpec,
} from '@/server/schemas/v2/admin/index.js';
import Creator from '@/models/credits/Creator.js';
import User from '@/models/auth/User.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {CreatorProfileDeletionService} from '@/server/services/accounts/CreatorProfileDeletionService.js';

const router: Router = Router();

router.delete(
  '/:id([0-9]{1,20})',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'deleteAdminCreator',
    summary: 'Delete creator profile',
    description:
      'Removes team memberships and aliases, strips credits, soft-deletes solo levels (chart files preserved), deletes CDN banner, and destroys the creator row. Query unlinkOnly=1 only clears user linkage (users.creatorId and creators.userId).',
    tags: ['Admin', 'Creators'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'Deleted or unlinked' }, ...standardErrorResponses404500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const creatorId = parseInt(req.params.id, 10);
      const unlinkOnly = String(req.query.unlinkOnly || '') === '1';

      const creator = await Creator.findByPk(creatorId);
      if (!creator) {
        return res.status(404).json({error: 'Creator not found'});
      }

      if (unlinkOnly) {
        await CreatorProfileDeletionService.getInstance().unlinkCreatorFromUser(creatorId);
        await User.update({creatorId: null}, {where: {creatorId}});
        logger.info('[admin] Creator unlinked from user(s)', {
          creatorId,
          actorUserId: req.user?.id,
        });
        return res.json({success: true, mode: 'unlink'});
      }

      await CreatorProfileDeletionService.getInstance().purgeCreatorProfile(creatorId);

      logger.info('[admin] Creator profile purged', {
        creatorId,
        actorUserId: req.user?.id,
      });

      return res.json({success: true, mode: 'purge'});
    } catch (error) {
      logger.error('Admin creator delete failed:', error);
      return res.status(500).json({error: 'Failed to delete creator'});
    }
  },
);

export default router;
