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
import {youtubeChannelVideoService} from '@/server/services/accounts/YoutubeChannelVideoService.js';

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

function queryString(raw: unknown, maxLength: number): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, maxLength);
}

router.get(
  '/:channelId/videos',
  Auth.user(),
  requireYoutubeChannelLinking,
  ApiDoc({
    operationId: 'getYoutubeChannelVideos',
    summary: 'List videos on a linked YouTube channel',
    description:
      'Recent uploads for a channel linked to the current user. Public videos are listed with the API key. Unlisted videos are included when a refresh token is stored. Private videos are omitted.',
    tags: ['Auth'],
    security: ['bearerAuth'],
    params: {channelId: {schema: {type: 'string'}}},
    query: {
      q: {schema: {type: 'string'}},
      pageToken: {schema: {type: 'string'}},
    },
    responses: {
      200: {description: 'Channel videos'},
      400: {schema: errorResponseSchema},
      401: {schema: errorResponseSchema},
      404: {schema: errorResponseSchema},
      502: {schema: errorResponseSchema},
      503: {schema: errorResponseSchema},
    },
  }),
  async (req: Request, res: Response) => {
    const channelId = channelIdParam(req.params.channelId);
    if (!channelId) {
      return res.status(400).json({error: 'channelId is required'});
    }
    try {
      const result = await youtubeChannelVideoService.listForUser({
        userId: req.user!.id,
        channelId,
        query: queryString(req.query.q, 200),
        pageToken: queryString(req.query.pageToken, 500) || null,
      });
      return res.json(result);
    } catch (error) {
      if (isYoutubeChannelError(error)) {
        return res.status(error.status).json({error: error.message, code: error.code});
      }
      logger.error('Failed to list YouTube channel videos:', error);
      return res.status(500).json({error: 'Failed to list YouTube channel videos'});
    }
  },
);

export default router;
