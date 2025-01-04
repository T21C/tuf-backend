import { Router, Request, Response } from 'express';
import { Auth } from '../../middleware/auth';

const router: Router = Router();

// Verify email (disabled - auto success)
router.get('/email/:token', (req: Request, res: Response) => {
  return res.json({ message: 'Email verification temporarily disabled. Proceeding with verified status.' });
});

// Resend verification email (disabled - auto success)
router.post('/resend', Auth.user(), (req: Request, res: Response) => {
  return res.json({ message: 'Email verification temporarily disabled. Proceeding with verified status.' });
});

export default router; 