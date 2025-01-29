import {Router} from 'express';
import levelRoutes from './levels.js';
import passRoutes from './passes.js';
import playerRoutes from './players.js';
import leaderboardRoutes from './leaderboard.js';
import difficultyRoutes from './diffs.js';
import referenceRoutes from './references.js';
import statisticsRoutes from './statistics.js';
import creatorRoutes from './creators.js';
import {Cache} from '../../middleware/cache.js';

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
  router.use('/creators', creatorRoutes);

  return router;
}
