import {Router} from 'express';
import levelRoutes from './levels';
import passRoutes from './passes';
import playerRoutes from './players';
import leaderboardRoutes from './leaderboard';
import difficultyRoutes from './diffs';
import referenceRoutes from './references';
import statisticsRoutes from './statistics';
import {Cache} from '../../middleware/cache';

export default function createDatabaseRouter(): Router {
  const router = Router();

  // Initialize routes with leaderboardCache middleware
  router.use('/levels', Cache.leaderboard(), levelRoutes);
  router.use('/passes', Cache.leaderboard(), passRoutes);
  router.use('/players', Cache.leaderboard(), playerRoutes);
  router.use('/leaderboard', Cache.leaderboard(), leaderboardRoutes);
  router.use('/difficulties', difficultyRoutes);
  router.use('/references', referenceRoutes);
  router.use('/statistics', statisticsRoutes);

  return router;
}
