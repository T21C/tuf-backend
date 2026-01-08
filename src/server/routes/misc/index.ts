import { Router } from 'express';
import utilsRoutes from './utils.js';
import mediaRoutes from './media.js';
import thumbnailRoutes from './thumbnails.js';
import formRoutes from './form.js';
import eventsRoutes from './events.js';
import discordRoutes from './discord.js';
import chunkedUploadRoutes from './chunkedUpload.js';

const router: Router = Router();

// Utils routes
router.use('/utils', utilsRoutes);

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

// Chunked upload routes
router.use('/chunked-upload', chunkedUploadRoutes);

export default router;
