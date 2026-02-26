import {Router} from 'express';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { errorResponseSchema, standardErrorResponses500 } from '@/server/schemas/v2/misc/index.js';
import {fetchDiscordUserInfo} from '@/misc/utils/auth/discord.js';
import { logger } from '@/server/services/LoggerService.js';

const router: Router = Router();

router.get(
  '/users/:userId',
  ApiDoc({
    operationId: 'getDiscordUser',
    summary: 'Discord user info',
    description: 'Fetches Discord user profile (username, avatar) by Discord user ID.',
    tags: ['Discord'],
    params: { userId: { description: 'Discord user ID (numeric)', schema: { type: 'string', pattern: '^\\d+$' } } },
    responses: {
      200: {
        description: 'User info',
        schema: {
          type: 'object',
          properties: { id: { type: 'string' }, username: { type: 'string' }, avatar: { type: 'string' }, avatarUrl: { type: 'string', description: 'URL or null' } },
        },
      },
      400: { description: 'Invalid user ID format', schema: errorResponseSchema },
      500: { description: 'Failed to fetch Discord user', schema: errorResponseSchema },
    },
  }),
  async (req, res) => {
  try {
    const {userId} = req.params;

    // Validate userId format
    if (!/^\d+$/.test(userId)) {
      return res.status(400).json({error: 'Invalid Discord user ID format'});
    }

    const userInfo = await fetchDiscordUserInfo(userId);

    return res.json({
      id: userId,
      username: userInfo.username,
      avatar: userInfo.avatar,
      avatarUrl: userInfo.avatar || null,
    });
  } catch (error) {
    logger.error('Error fetching Discord user:', error);
    return res.status(500).json({error: 'Failed to fetch Discord user info'});
  }
  }
);

export default router;
