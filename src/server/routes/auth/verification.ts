import {Router} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {authController} from '@/server/controllers/auth.js';

const router: Router = Router();

// Verify email
router.post('/email', authController.verifyEmail);

// Resend verification email
router.post('/resend', Auth.user(), authController.resendVerification);

export default router;
