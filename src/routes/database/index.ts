import {Router} from 'express';
import levelRoutes from './levels/index.js';
import passRoutes from './passes.js';
import playerRoutes from './players.js';
import leaderboardRoutes from './leaderboard.js';
import difficultyRoutes from './difficulties.js';
import referenceRoutes from './references.js';
import statisticsRoutes from './statistics.js';
import creatorRoutes from './creators.js';

export const MAX_LIMIT = 200;

export default function createDatabaseRouter(): Router {
  const router = Router();

  // Initialize routes with leaderboardCache middleware
  router.use('/levels', levelRoutes);
  router.use('/passes', passRoutes);
  router.use('/players', playerRoutes);
  router.use('/leaderboard', leaderboardRoutes);
  router.use('/difficulties', difficultyRoutes);
  router.use('/references', referenceRoutes);
  router.use('/statistics', statisticsRoutes);
  router.use('/creators', creatorRoutes);

  return router;
}
