import {Router, Request, Response} from 'express';
import {Auth} from '../../middleware/auth.js';
import {authController} from '../../controllers/auth.js';

const router: Router = Router();

// Verify email
router.post('/email', authController.verifyEmail);

// Resend verification email
router.post('/resend', Auth.user(), authController.resendVerification);

export default router;
