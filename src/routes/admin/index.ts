import {Router} from 'express';
import ratingRoutes from './rating.js';
import submissionRoutes from './submissions.js';
import backupRoutes from './backup.js';
import usersRoutes from './users.js';
import statisticsRoutes from './statistics.js';
// Import other admin routes here

const router: Router = Router();

router.use('/rating', ratingRoutes);
router.use('/submissions', submissionRoutes);
router.use('/backup', backupRoutes);
router.use('/users', usersRoutes);
router.use('/statistics', statisticsRoutes);
// Add other admin routes here

export default router;
