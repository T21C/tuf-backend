import express, {Router} from 'express';
import chartsRoutes from './charts';
import playersRoute from './players';
import passesRoute from './passes';
import leaderboardRoute from './leaderboard';
// Import other admin routes here

const router: Router = express.Router();

router.use('/charts', chartsRoutes);
router.use('/players', playersRoute);
router.use('/passes', passesRoute);
router.use('/leaderboard', leaderboardRoute);
// Add other admin routes here

export default router;