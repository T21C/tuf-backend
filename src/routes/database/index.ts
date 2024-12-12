import express, {Router} from 'express';
import levelsRoutes from './levels';
import playersRoute from './players';
import passesRoute from './passes';
import leaderboardRoute from './leaderboard';
import diffsRoute from './diffs';
// Import other admin routes here

const router: Router = express.Router();

router.use('/levels', levelsRoutes);
router.use('/players', playersRoute);
router.use('/passes', passesRoute);
router.use('/leaderboard', leaderboardRoute);
router.use('/diffs', diffsRoute);
// Add other admin routes here

export default router;
