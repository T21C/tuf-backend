import express, {Router} from 'express';
import ratingRoutes from './rating';
import submissionRoutes from './submissions';
import backupRoutes from './backup';
import ratersRoutes from './raters';
// Import other admin routes here

const router: Router = Router();

router.use('/rating', ratingRoutes);
router.use('/submissions', submissionRoutes);
router.use('/backup', backupRoutes);
router.use('/raters', ratersRoutes);
// Add other admin routes here

export default router;
