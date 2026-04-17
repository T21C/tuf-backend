import { Router } from 'express';

import levelRouter from './level/index.js';
import passRouter from './pass/index.js';

const router: Router = Router();

router.use('/level', levelRouter);
router.use('/pass', passRouter);

export default router;
