import { Router } from 'express';
import playersRouter from './players.js';
import creatorsRouter from './creators.js';

const router: Router = Router();

router.use('/players', playersRouter);
router.use('/creators', creatorsRouter);

export default router;
