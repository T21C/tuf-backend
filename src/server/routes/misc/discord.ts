import {Router} from 'express';
import {fetchDiscordUserInfo} from '../../../utils/auth/discord.js';
import { logger } from '../../services/LoggerService.js';

const router: Router = Router();

router.get('/users/:userId', async (req, res) => {
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
});

export default router;
