import { Router } from 'express';
import v2Router from './v2/index.js';

const router: Router = Router();

router.use('/v2', v2Router);

export default router;