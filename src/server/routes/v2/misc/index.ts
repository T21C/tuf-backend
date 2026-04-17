import { Router } from 'express';
import utilsRoutes from './utils.js';
import mediaRoutes from './media.js';
import thumbnailRoutes from './thumbnails.js';
import formRoutes from './form/index.js';
import eventsRoutes from './events.js';
import discordRoutes from './discord.js';
import chunkedUploadRoutes from './chunkedUpload.js';
import uploadRoutes from './upload.js';
import externalRouter from './external.js';
import jobsRoutes from './jobs.js';

const router: Router = Router();

// Utils routes
router.use('/utils', utilsRoutes);

// External routes
router.use('/external', externalRouter);

// Media routes
router.use('/media', mediaRoutes);

// Thumbnail routes
router.use('/media', thumbnailRoutes);

// Form routes
router.use('/form', formRoutes);

// Events routes
router.use('/events', eventsRoutes);

// Discord routes
router.use('/discord', discordRoutes);

// Chunked upload routes (legacy — kept while clients migrate)
router.use('/chunked-upload', chunkedUploadRoutes);

// New kind-based chunked upload router (session + kind + sha256)
router.use('/upload', uploadRoutes);

// Job progress (read)
router.use('/jobs', jobsRoutes);

export default router;
