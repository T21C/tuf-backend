import { Router } from 'express';
import utilsRoutes from './utils.js';
import mediaRoutes from './media.js';
import formRoutes from './form.js';
import eventsRoutes from './events.js';
import discordRoutes from './discord.js';
import profilingRoutes from './profiling.js';

const router: Router = Router();

// Utils routes
router.use('/utils', utilsRoutes);

// Media routes
router.use('/media', mediaRoutes);

// Form routes
router.use('/form', formRoutes);

// Events routes
router.use('/events', eventsRoutes);

// Discord routes
router.use('/discord', discordRoutes);

// Profiling routes
router.use('/profiling', profilingRoutes);

export default router; 