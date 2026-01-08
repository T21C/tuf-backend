import {Router} from 'express';
import {authController} from '../../controllers/auth.js';

const router: Router = Router();

// Register new user
router.post('/', authController.register);

export default router;
