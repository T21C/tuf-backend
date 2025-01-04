import express, {Router} from 'express';
import ratingRoutes from './rating';
import submissionRoutes from './submissions';
import backupRoutes from './backup';
import usersRoutes from './users';
import statisticsRoutes from './statistics';
// Import other admin routes here

const router: Router = Router();

router.use('/rating', ratingRoutes);
router.use('/submissions', submissionRoutes);
router.use('/backup', backupRoutes);
router.use('/users', usersRoutes);
router.use('/statistics', statisticsRoutes);
// Add other admin routes here

export default router;
