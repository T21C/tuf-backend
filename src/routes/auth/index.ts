import { Router } from 'express';
import loginRoutes from './login';
import registerRoutes from './register';
import verificationRoutes from './verification';
import oauthRoutes from './oauth';
import profileRoutes from './profile';

const router: Router = Router();

router.use('/login', loginRoutes);
router.use('/register', registerRoutes);
router.use('/verify', verificationRoutes);
router.use('/oauth', oauthRoutes);
router.use('/profile', profileRoutes);

export default router; 