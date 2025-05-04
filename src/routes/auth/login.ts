import {Router, Request, Response} from 'express';
import {OAuthController} from '../../controllers/oauth.js';
import {authController} from '../../controllers/auth.js';
import { logger } from '../../services/LoggerService.js';

const router: Router = Router();

router.post('/', async (req: Request, res: Response) => {
  try {
    // Call the auth controller's login method directly
    return await authController.login(req, res);
  } catch (error) {
    logger.error('Login error:', error);
    return res.status(500).json({error: 'Failed to login'});
  }
});

// Login with OAuth provider
router.get('/:provider', OAuthController.initiateLogin);

export default router;
