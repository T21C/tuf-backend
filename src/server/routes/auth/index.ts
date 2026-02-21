import {Router} from 'express';
import loginRoutes from './login.js';
import registerRoutes from './register.js';
import verificationRoutes from './verification.js';
import oauthRoutes from './oauth.js';
import profileRoutes from '../profile/profile.js';
import forgotPasswordRoutes from './forgotPassword.js';
import { authController } from '../../controllers/auth.js';
import { Auth } from '../../middleware/auth.js';

const router: Router = Router();

router.use('/login', loginRoutes);
router.use('/register', registerRoutes);
router.use('/verify', verificationRoutes);
router.use('/oauth', oauthRoutes);
router.use('/profile', profileRoutes);
router.use('/forgot-password', forgotPasswordRoutes);
router.post('/refresh', (req, res) => authController.refresh(req, res));
router.post('/logout', (req, res) => authController.logout(req, res));
router.get('/sessions', Auth.user(), (req, res) => authController.getSessions(req, res));
router.delete('/sessions/:id', Auth.user(), (req, res) => authController.revokeSession(req, res));

export default router;
