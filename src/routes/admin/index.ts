import express, {Router} from 'express';
import ratingRoutes from './rating';
import submissionRoutes from './submissions';
// Import other admin routes here

const router: Router = express.Router();

router.use('/rating', ratingRoutes);
router.use('/submissions', submissionRoutes);
// Add other admin routes here

export default router;