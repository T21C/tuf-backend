import { Router, Request, Response } from 'express';
import { Cache } from '../../utils/cacheManager';
import { Auth } from '../../middleware/auth';

const router: Router = Router();

router.post('/reload', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    await Cache.reloadAll();
    res.json({ message: 'Cache reloaded successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reload cache' });
  }
});

export default router; 