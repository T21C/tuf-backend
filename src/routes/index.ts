import { Router } from 'express';
import authRoutes from './auth/index';
import adminRoutes from './admin';
import databaseRoutes from './database';
import webhookRoutes from './webhooks';

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