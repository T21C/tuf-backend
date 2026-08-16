import { Router } from 'express';

import levelRouter from './level/index.js';
import passRouter from './pass/index.js';
import listRouter from './list/listRoute.js';

const router: Router = Router();

router.use('/level', levelRouter);
router.use('/pass', passRouter);
router.use('/submissions', listRouter);

export default router;
