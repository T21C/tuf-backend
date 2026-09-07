import {Router, Request, Response, NextFunction} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {errorResponseSchema, successMessageSchema} from '@/server/schemas/v2/auth/index.js';
import {stepUpGrantService} from '@/server/services/auth/StepUpGrantService.js';
import {CacheInvalidation} from '@/server/middleware/cache.js';
import {
  youtubeChannelService,
  isYoutubeChannelError,
} from '@/server/services/accounts/YouTubeChannelService.js';
import {isYoutubeChannelLinkingEnabled, youtubeChannelLinkingDisabledPayload} from '@/config/app.config.js';
import {logger} from '@/server/services/core/LoggerService.js';

const router: Router = Router();

function requireYoutubeChannelLinking(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isYoutubeChannelLinkingEnabled()) {
    res.status(503).json(youtubeChannelLinkingDisabledPayload());
    return;
  }
  next();
}

function channelIdParam(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

router.post(
  '/:channelId/primary',
  Auth.user(),
  requireYoutubeChannelLinking,
  stepUpGrantService.requireStepUp('security'),
  ApiDoc({
    operationId: 'postYoutubeChannelPrimary',
    summary: 'Set primary YouTube channel',
    description: 'Mark one linked YouTube channel as the profile header primary. Requires step-up.',
    tags: ['Auth'],
    security: ['bearerAuth'],
    params: {channelId: {schema: {type: 'string'}}},
    responses: {
      200: {description: 'Updated channel list'},
      401: {schema: errorResponseSchema},
      403: {schema: errorResponseSchema},
      404: {schema: errorResponseSchema},
    },
  }),
  async (req: Request, res: Response) => {
    const channelId = channelIdParam(req.params.channelId);
    if (!channelId) {
      return res.status(400).json({error: 'channelId is required'});
    }
    try {
      const youtubeChannels = await youtubeChannelService.setPrimary(req.user!.id, channelId);
      await CacheInvalidation.invalidateUser(req.user!.id);
      return res.json({youtubeChannels});
    } catch (error) {
      if (isYoutubeChannelError(error)) {
        return res.status(error.status).json({error: error.message, code: error.code});
      }
      logger.error('Failed to set primary YouTube channel:', error);
      return res.status(500).json({error: 'Failed to set primary YouTube channel'});
    }
  },
);

router.delete(
  '/:channelId',
  Auth.user(),
  requireYoutubeChannelLinking,
  stepUpGrantService.requireStepUp('security'),
  ApiDoc({
    operationId: 'deleteYoutubeChannel',
    summary: 'Unlink a YouTube channel',
    description: 'Remove a linked YouTube channel. Requires recent step-up confirmation.',
    tags: ['Auth'],
    security: ['bearerAuth'],
    params: {channelId: {schema: {type: 'string'}}},
    responses: {
      200: {schema: successMessageSchema},
      401: {schema: errorResponseSchema},
      403: {schema: errorResponseSchema},
      404: {schema: errorResponseSchema},
    },
  }),
  async (req: Request, res: Response) => {
    const channelId = channelIdParam(req.params.channelId);
    if (!channelId) {
      return res.status(400).json({error: 'channelId is required'});
    }
    try {
      const youtubeChannels = await youtubeChannelService.unlink(req.user!.id, channelId);
      await CacheInvalidation.invalidateUser(req.user!.id);
      return res.json({success: true, youtubeChannels});
    } catch (error) {
      if (isYoutubeChannelError(error)) {
        return res.status(error.status).json({error: error.message, code: error.code});
      }
      logger.error('Failed to unlink YouTube channel:', error);
      return res.status(500).json({error: 'Failed to unlink YouTube channel'});
    }
  },
);

export default router;
