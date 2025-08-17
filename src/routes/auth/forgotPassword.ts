import {Router} from 'express';
import {authController} from '../../controllers/auth.js';

const router: Router = Router();

// Request password reset
router.post('/request', authController.requestPasswordReset);

// Reset password with token
router.post('/reset', authController.resetPassword);

export default router;
