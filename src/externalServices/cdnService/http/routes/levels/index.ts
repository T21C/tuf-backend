import { Router } from 'express';
import transformRoutes from './transformRoutes.js';
import chartRoutes from './chartRoutes.js';
import levelDataRoutes from './levelDataRoutes.js';

const router = Router();

// Keep static paths before `/:fileId/*` matchers.
router.use(transformRoutes);
router.use(chartRoutes);
router.use(levelDataRoutes);

export default router;
