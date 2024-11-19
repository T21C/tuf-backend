import express, {Router} from 'express';
import chartsRoutes from './charts';
import playersRoute from './players';
import passesRoute from './passes';
// Import other admin routes here

const router: Router = express.Router();

router.use('/charts', chartsRoutes);
router.use('/players', playersRoute);
router.use('/passes', passesRoute);
// Add other admin routes here

export default router;