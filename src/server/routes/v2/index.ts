import {Router} from 'express';
import authRoutes from './auth/index.js';
import adminRoutes from './admin/index.js';
import databaseRoutes from './database/index.js';
import webhookRoutes from './webhooks/index.js';
import miscRoutes from './misc/index.js';
import healthRoutes from './misc/health.js';
import cdnProgressRoutes from './misc/cdnProgress.js';
import developersRoutes from './developers/index.js';
import oauthConsentRoutes from './oauth/index.js';

const router: Router = Router();

// Auth routes
router.use('/auth', authRoutes);

// Developer portal (OAuth apps)
router.use('/developers', developersRoutes);

// OAuth consent APIs (SPA companion; protocol endpoints stay on /oauth/*)
router.use('/oauth', oauthConsentRoutes);

// Admin routes
router.use('/admin', adminRoutes);

// Database routes
router.use('/database', databaseRoutes());

// Webhook routes
router.use('/webhook', webhookRoutes);

// Misc routes
router.use('/', miscRoutes);

// CDN job progress ingest (trusted callers)
router.use('/cdn', cdnProgressRoutes);

// Health check endpoint
router.use('/health', healthRoutes);

export default router;
