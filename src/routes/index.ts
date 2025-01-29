import {Router} from 'express';
import authRoutes from './auth/index.js';
import adminRoutes from './admin/index.js';
import databaseRoutes from './database/index.js';
import webhookRoutes from './webhooks/index.js';

const router: Router = Router();

// Auth routes
router.use('/auth', authRoutes);

// Admin routes
router.use('/admin', adminRoutes);

// Database routes
router.use('/database', databaseRoutes);

// Webhook routes
router.use('/webhooks', webhookRoutes);

export default router;
