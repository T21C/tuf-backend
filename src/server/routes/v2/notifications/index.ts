import {Router, Request, Response} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {
  errorResponseSchema,
  standardErrorResponses401500,
  standardErrorResponses401404500,
  successMessageSchema,
} from '@/server/schemas/common.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {getVapidConfig, isPushAvailable} from '@/config/app.config.js';
import {notificationService} from '@/server/services/notifications/NotificationService.js';
import {
  getChartClearMuteState,
  setChartClearMuted,
} from '@/server/services/notifications/chartClearNotify.js';
import {
  deletePushSubscription,
  upsertPushSubscription,
} from '@/server/services/notifications/PushSubscriptionService.js';

const router: Router = Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function parsePositiveInt(value: unknown): number | null {
  const n = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

router.get(
  '/',
  Auth.user(),
  ApiDoc({
    operationId: 'getNotifications',
    summary: 'List inbox notifications',
    description: 'Cursor-paginated inbox for the authenticated user. Newest first. Query: cursor (last id), limit (default 20, max 50).',
    tags: ['Notifications'],
    security: ['bearerAuth'],
    query: {
      cursor: {description: 'Return rows with id less than this value', schema: {type: 'string'}},
      limit: {description: 'Page size', schema: {type: 'integer'}},
    },
    responses: {
      200: {
        description: 'Notification page',
        schema: {
          type: 'object',
          properties: {
            notifications: {type: 'array', items: {type: 'object'}},
            nextCursor: {type: 'integer', nullable: true},
          },
        },
      },
      ...standardErrorResponses401500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({error: 'User not authenticated'});
      const limitRaw = parsePositiveInt(req.query.limit);
      const limit = Math.min(limitRaw ?? DEFAULT_LIMIT, MAX_LIMIT);
      const cursor = parsePositiveInt(req.query.cursor);
      const page = await notificationService.listForUser(userId, {cursor, limit});
      return res.json(page);
    } catch (error) {
      logger.error('Error listing notifications:', error);
      return res.status(500).json({error: 'Failed to list notifications'});
    }
  },
);

router.get(
  '/unread-count',
  Auth.user(),
  ApiDoc({
    operationId: 'getNotificationsUnreadCount',
    summary: 'Unread inbox count',
    description: 'Count of unread inbox notifications for the authenticated user.',
    tags: ['Notifications'],
    security: ['bearerAuth'],
    responses: {
      200: {
        description: 'Unread count',
        schema: {type: 'object', properties: {count: {type: 'integer'}}},
      },
      ...standardErrorResponses401500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({error: 'User not authenticated'});
      const count = await notificationService.unreadCount(userId);
      return res.json({count});
    } catch (error) {
      logger.error('Error counting unread notifications:', error);
      return res.status(500).json({error: 'Failed to count unread notifications'});
    }
  },
);

router.get(
  '/preferences',
  Auth.user(),
  ApiDoc({
    operationId: 'getNotificationPreferences',
    summary: 'Notification preferences',
    description: 'Effective per-type and per-category in-app preferences merged with registry defaults.',
    tags: ['Notifications'],
    security: ['bearerAuth'],
    responses: {
      200: {
        description: 'Preferences',
        schema: {
          type: 'object',
          properties: {
            preferences: {type: 'array', items: {type: 'object'}},
            categories: {type: 'array', items: {type: 'object'}},
            pushEnabled: {type: 'boolean'},
            pushAvailable: {type: 'boolean'},
          },
        },
      },
      ...standardErrorResponses401500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({error: 'User not authenticated'});
      const state = await notificationService.getPreferenceState(userId);
      return res.json(state);
    } catch (error) {
      logger.error('Error fetching notification preferences:', error);
      return res.status(500).json({error: 'Failed to fetch notification preferences'});
    }
  },
);

router.put(
  '/preferences',
  Auth.user(),
  ApiDoc({
    operationId: 'putNotificationPreferences',
    summary: 'Update a notification preference',
    description:
      'Upsert in-app preference for one registry type or one category, or set account-wide pushEnabled. Locked channels cannot be changed.',
    tags: ['Notifications'],
    security: ['bearerAuth'],
    requestBody: {
      description: 'Type or category id and inApp flag, or pushEnabled',
      schema: {
        type: 'object',
        properties: {
          type: {type: 'string'},
          category: {type: 'string'},
          inApp: {type: 'boolean'},
          pushEnabled: {type: 'boolean'},
        },
      },
    },
    responses: {
      200: {
        description: 'Updated preference',
        schema: {
          type: 'object',
          properties: {
            preference: {type: 'object'},
            preferences: {type: 'array', items: {type: 'object'}},
            categories: {type: 'array', items: {type: 'object'}},
          },
        },
      },
      400: {schema: errorResponseSchema},
      ...standardErrorResponses401500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({error: 'User not authenticated'});
      if (typeof req.body?.pushEnabled === 'boolean' && typeof req.body?.inApp !== 'boolean') {
        const state = await notificationService.setPushEnabled(userId, req.body.pushEnabled);
        return res.json(state);
      }
      if (typeof req.body?.inApp !== 'boolean') {
        return res.status(400).json({error: 'inApp must be a boolean'});
      }
      const category = typeof req.body?.category === 'string' ? req.body.category : '';
      if (category) {
        const state = await notificationService.upsertCategoryInAppPreference(
          userId,
          category,
          req.body.inApp,
        );
        if (!state) return res.status(400).json({error: 'Unknown notification category'});
        return res.json(state);
      }
      const type = typeof req.body?.type === 'string' ? req.body.type : '';
      const preference = await notificationService.upsertInAppPreference(userId, type, req.body.inApp);
      if (!preference) return res.status(400).json({error: 'Unknown notification type'});
      return res.json({preference});
    } catch (error) {
      logger.error('Error updating notification preference:', error);
      return res.status(500).json({error: 'Failed to update notification preference'});
    }
  },
);

router.get(
  '/chart-clears/:levelId',
  Auth.user(),
  ApiDoc({
    operationId: 'getChartClearMute',
    summary: 'Per-chart clear notification mute state',
    description:
      'Returns whether the current user is a charter or vfxer on this level and whether they muted chart-cleared notifications for it.',
    tags: ['Notifications'],
    security: ['bearerAuth'],
    params: {levelId: {schema: {type: 'string', pattern: '^[0-9]{1,20}$'}}},
    responses: {
      200: {
        description: 'Mute state',
        schema: {
          type: 'object',
          properties: {
            credited: {type: 'boolean'},
            muted: {type: 'boolean'},
          },
        },
      },
      400: {schema: errorResponseSchema},
      ...standardErrorResponses401500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({error: 'User not authenticated'});
      const levelId = parsePositiveInt(req.params.levelId);
      if (!levelId) return res.status(400).json({error: 'Invalid level id'});
      const state = await getChartClearMuteState(userId, req.user?.creatorId, levelId);
      return res.json(state);
    } catch (error) {
      logger.error('Error fetching chart-clear mute state:', error);
      return res.status(500).json({error: 'Failed to fetch mute state'});
    }
  },
);

router.put(
  '/chart-clears/:levelId',
  Auth.user(),
  ApiDoc({
    operationId: 'putChartClearMute',
    summary: 'Mute or unmute chart-cleared notifications for a level',
    description:
      'Creates or removes a per-level mute for chart.cleared. Only charters and vfxers credited on the level can change this.',
    tags: ['Notifications'],
    security: ['bearerAuth'],
    params: {levelId: {schema: {type: 'string', pattern: '^[0-9]{1,20}$'}}},
    requestBody: {
      description: 'muted flag',
      schema: {
        type: 'object',
        properties: {muted: {type: 'boolean'}},
        required: ['muted'],
      },
    },
    responses: {
      200: {
        description: 'Updated mute state',
        schema: {
          type: 'object',
          properties: {
            credited: {type: 'boolean'},
            muted: {type: 'boolean'},
          },
        },
      },
      400: {schema: errorResponseSchema},
      403: {schema: errorResponseSchema},
      ...standardErrorResponses401500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({error: 'User not authenticated'});
      const levelId = parsePositiveInt(req.params.levelId);
      if (!levelId) return res.status(400).json({error: 'Invalid level id'});
      if (typeof req.body?.muted !== 'boolean') {
        return res.status(400).json({error: 'muted must be a boolean'});
      }
      const result = await setChartClearMuted(
        userId,
        req.user?.creatorId,
        levelId,
        req.body.muted,
      );
      if ('error' in result) {
        return res.status(403).json({error: 'Not credited as charter or vfxer on this level'});
      }
      return res.json(result);
    } catch (error) {
      logger.error('Error updating chart-clear mute:', error);
      return res.status(500).json({error: 'Failed to update mute state'});
    }
  },
);

function pushUnavailable(res: Response): Response {
  return res.status(404).json({error: 'Push notifications are not available'});
}

router.get(
  '/push/vapid-key',
  Auth.user(),
  ApiDoc({
    operationId: 'getPushVapidKey',
    summary: 'Public VAPID key',
    description: 'Returns the public VAPID key for Web Push subscription. 404 when push is disabled.',
    tags: ['Notifications'],
    security: ['bearerAuth'],
    responses: {
      200: {
        description: 'Public VAPID key',
        schema: {type: 'object', properties: {publicKey: {type: 'string'}}},
      },
      ...standardErrorResponses401404500,
    },
  }),
  async (_req: Request, res: Response) => {
    try {
      const vapid = getVapidConfig();
      if (!isPushAvailable() || !vapid) return pushUnavailable(res);
      return res.json({publicKey: vapid.publicKey});
    } catch (error) {
      logger.error('Error fetching VAPID key:', error);
      return res.status(500).json({error: 'Failed to fetch VAPID key'});
    }
  },
);

router.post(
  '/push/subscribe',
  Auth.user(),
  ApiDoc({
    operationId: 'postPushSubscribe',
    summary: 'Save a Web Push subscription',
    description: 'Upserts this browser PushSubscription and locale for the authenticated user.',
    tags: ['Notifications'],
    security: ['bearerAuth'],
    requestBody: {
      description: 'PushSubscription JSON plus locale',
      schema: {
        type: 'object',
        properties: {
          endpoint: {type: 'string'},
          expirationTime: {type: 'number', nullable: true},
          keys: {
            type: 'object',
            properties: {p256dh: {type: 'string'}, auth: {type: 'string'}},
          },
          locale: {type: 'string'},
        },
        required: ['endpoint', 'keys'],
      },
    },
    responses: {
      200: {schema: successMessageSchema},
      400: {schema: errorResponseSchema},
      ...standardErrorResponses401404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({error: 'User not authenticated'});
      if (!isPushAvailable()) return pushUnavailable(res);
      await upsertPushSubscription(userId, {
        endpoint: req.body?.endpoint,
        expirationTime: req.body?.expirationTime,
        keys: req.body?.keys,
        locale: req.body?.locale,
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      });
      return res.json({message: 'OK'});
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Invalid')) {
        return res.status(400).json({error: error.message});
      }
      logger.error('Error saving push subscription:', error);
      return res.status(500).json({error: 'Failed to save push subscription'});
    }
  },
);

router.delete(
  '/push/subscribe',
  Auth.user(),
  ApiDoc({
    operationId: 'deletePushSubscribe',
    summary: 'Remove a Web Push subscription',
    description: 'Deletes this browser PushSubscription for the authenticated user.',
    tags: ['Notifications'],
    security: ['bearerAuth'],
    requestBody: {
      description: 'Endpoint to remove',
      schema: {
        type: 'object',
        properties: {endpoint: {type: 'string'}},
        required: ['endpoint'],
      },
    },
    responses: {
      200: {schema: successMessageSchema},
      ...standardErrorResponses401404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({error: 'User not authenticated'});
      if (!isPushAvailable()) return pushUnavailable(res);
      const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
      if (!endpoint) return res.status(400).json({error: 'endpoint is required'});
      await deletePushSubscription(userId, endpoint);
      return res.json({message: 'OK'});
    } catch (error) {
      logger.error('Error deleting push subscription:', error);
      return res.status(500).json({error: 'Failed to delete push subscription'});
    }
  },
);

router.post(
  '/read-all',
  Auth.user(),
  ApiDoc({
    operationId: 'postNotificationsReadAll',
    summary: 'Mark all notifications read',
    description: 'Sets readAt (and seenAt) on every unread inbox row for the current user.',
    tags: ['Notifications'],
    security: ['bearerAuth'],
    responses: {
      200: {description: 'Updated count', schema: {type: 'object', properties: {updated: {type: 'integer'}}}},
      ...standardErrorResponses401500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({error: 'User not authenticated'});
      const updated = await notificationService.markAllRead(userId);
      return res.json({updated});
    } catch (error) {
      logger.error('Error marking all notifications read:', error);
      return res.status(500).json({error: 'Failed to mark notifications read'});
    }
  },
);

router.post(
  '/seen',
  Auth.user(),
  ApiDoc({
    operationId: 'postNotificationsSeen',
    summary: 'Mark notifications seen',
    description: 'Sets seenAt on unseen inbox rows (dropdown opened).',
    tags: ['Notifications'],
    security: ['bearerAuth'],
    responses: {
      200: {schema: successMessageSchema},
      ...standardErrorResponses401500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({error: 'User not authenticated'});
      const updated = await notificationService.markSeen(userId);
      return res.json({message: 'OK', updated});
    } catch (error) {
      logger.error('Error marking notifications seen:', error);
      return res.status(500).json({error: 'Failed to mark notifications seen'});
    }
  },
);

router.post(
  '/:id/read',
  Auth.user(),
  ApiDoc({
    operationId: 'postNotificationRead',
    summary: 'Mark one notification read',
    description: 'Sets readAt on a single inbox row owned by the current user.',
    tags: ['Notifications'],
    security: ['bearerAuth'],
    params: {id: {schema: {type: 'string', pattern: '^[0-9]{1,20}$'}}},
    responses: {
      200: {description: 'Updated notification', schema: {type: 'object'}},
      ...standardErrorResponses401404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({error: 'User not authenticated'});
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({error: 'Invalid notification id'});
      const notification = await notificationService.markRead(userId, id);
      if (!notification) return res.status(404).json({error: 'Notification not found'});
      return res.json({notification});
    } catch (error) {
      logger.error('Error marking notification read:', error);
      return res.status(500).json({error: 'Failed to mark notification read'});
    }
  },
);

router.post(
  '/:id/hide',
  Auth.user(),
  ApiDoc({
    operationId: 'postNotificationHide',
    summary: 'Hide one notification',
    description:
      'Soft-hides an inbox row owned by the current user. Optional disableType turns off that notification type for future in-app rows.',
    tags: ['Notifications'],
    security: ['bearerAuth'],
    params: {id: {schema: {type: 'string', pattern: '^[0-9]{1,20}$'}}},
    requestBody: {
      description: 'Optional disableType to mute this notification type going forward',
      schema: {
        type: 'object',
        properties: {
          disableType: {type: 'boolean'},
        },
      },
    },
    responses: {
      200: {
        description: 'Hidden',
        schema: {
          type: 'object',
          properties: {
            hidden: {type: 'boolean'},
            unreadDelta: {type: 'integer'},
            type: {type: 'string'},
          },
        },
      },
      ...standardErrorResponses401404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({error: 'User not authenticated'});
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({error: 'Invalid notification id'});
      const disableType = req.body?.disableType === true;
      const result = await notificationService.hide(userId, id, {disableType});
      if (!result) return res.status(404).json({error: 'Notification not found'});
      return res.json(result);
    } catch (error) {
      logger.error('Error hiding notification:', error);
      return res.status(500).json({error: 'Failed to hide notification'});
    }
  },
);

export default router;
