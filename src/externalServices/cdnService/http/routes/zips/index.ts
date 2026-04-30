import { Router } from 'express';
import packDownloadRoutes from './packDownloadRoutes.js';
import zipMetadataRoutes from './zipMetadataRoutes.js';
import ingestRoutes from './ingestRoutes.js';

const router = Router();

// Order matters a little: keep static `/packs/*` paths before `/:fileId/*` matchers.
router.use(packDownloadRoutes);
router.use(zipMetadataRoutes);
router.use(ingestRoutes);

export default router;
