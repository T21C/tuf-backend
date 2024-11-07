import express from 'express';
import ratingRoutes from './rating.js';
import submissionRoutes from './submissions.js';
// Import other admin routes here

const router = express.Router();

router.use('/rating', ratingRoutes);
router.use('/submissions', submissionRoutes);
// Add other admin routes here

export default router;