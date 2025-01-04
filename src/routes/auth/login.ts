import { Router } from 'express';
import { authController } from '../../controllers/auth';
import { OAuthController } from '../../controllers/oauth';

const router: Router = Router();

// Login with email/password
router.post('/', authController.login);

// Login with OAuth provider
router.get('/:provider', OAuthController.initiateLogin);

export default router; 