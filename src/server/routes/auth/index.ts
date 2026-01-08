import {Router} from 'express';
import loginRoutes from './login.js';
import registerRoutes from './register.js';
import verificationRoutes from './verification.js';
import oauthRoutes from './oauth.js';
import profileRoutes from '../profile/profile.js';
import forgotPasswordRoutes from './forgotPassword.js';

const router: Router = Router();

router.use('/login', loginRoutes);
router.use('/register', registerRoutes);
router.use('/verify', verificationRoutes);
router.use('/oauth', oauthRoutes);
router.use('/profile', profileRoutes);
router.use('/forgot-password', forgotPasswordRoutes);

export default router;
