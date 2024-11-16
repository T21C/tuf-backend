import express, {Router} from 'express';
import chartsRoutes from './routes/charts';
import playersRoute from './routes/players';
import passesRoute from './routes/passes';
// Import other admin routes here

const router: Router = express.Router();

router.use('/charts', chartsRoutes);
router.use('/players', playersRoute);
router.use('/passes', passesRoute);
// Add other admin routes here

export default router;