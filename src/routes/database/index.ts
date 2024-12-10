import express, {Router} from 'express';
import levelsRoutes from './levels';
import playersRoute from './players';
import passesRoute from './passes';
import leaderboardRoute from './leaderboard';
// Import other admin routes here

const router: Router = express.Router();

router.use('/levels', levelsRoutes);
router.use('/players', playersRoute);
router.use('/passes', passesRoute);
router.use('/leaderboard', leaderboardRoute);
// Add other admin routes here

export default router;
