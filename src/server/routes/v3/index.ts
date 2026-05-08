import { Router } from 'express';
import playersRouter from './players.js';
import creatorsRouter from './creators.js';
import levelsModificationRouter from './levels/modification.js';
import billingRoutes from './billing/index.js';

const router: Router = Router();

router.use('/players', playersRouter);
router.use('/creators', creatorsRouter);
router.use('/levels', levelsModificationRouter);
router.use('/billing', billingRoutes);


export default router;
