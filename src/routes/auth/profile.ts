import { Router, Request, Response } from 'express';
import { Auth } from '../../middleware/auth';

const router: Router = Router();

// Get current user profile
router.get('/me', Auth.user(), async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    return res.json({
      user: {
        id: user.id,
        username: user.username,
        nickname: user.nickname,
        email: user.email,
        avatarUrl: user.avatarUrl,
        isRater: user.isRater,
        isSuperAdmin: user.isSuperAdmin,
        playerId: user.playerId
      }
    });
  } catch (error) {
    console.error('Error fetching user profile:', error);
    return res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

export default router; 