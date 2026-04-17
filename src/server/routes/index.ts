import { Router } from 'express';
import v2Router from './v2/index.js';
import v3Router from './v3/index.js';

const router: Router = Router();

router.use('/v2', v2Router);
router.use('/v3', v3Router);

export default router;
