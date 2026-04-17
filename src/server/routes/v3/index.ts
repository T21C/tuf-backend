import { Router } from 'express';
import playersRouter from './players.js';

const router: Router = Router();

router.use('/players', playersRouter);

export default router;
