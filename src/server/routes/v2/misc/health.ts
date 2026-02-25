import express, { Request, Response, Router } from 'express';
import sequelize from '@/config/db.js';
import { getIO } from '@/misc/utils/server/socket.js';
import { logger } from '@/server/services/LoggerService.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { healthCheckResponseSchema, healthErrorResponseSchema } from '@/server/schemas/health.js';

const router: Router = express.Router();

/**
 * Health check endpoint
 * Returns the status of various system components
 */
router.get(
  '/',
  ApiDoc({
    summary: 'Health check',
    description: 'Returns status of database, socket server, and system info',
    tags: ['Health'],
    responses: {
      200: { description: 'Service status and checks', schema: healthCheckResponseSchema },
      500: { description: 'Service offline or error', schema: healthErrorResponseSchema },
    },
  }),
  async (req: Request, res: Response) => {
  try {
    // Check database connection
    const dbStatus = await checkDatabase();

    // Check socket server
    const socketStatus = checkSocketServer();

    // Get system information
    const systemInfo = {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      nodeVersion: process.version,
      platform: process.platform,
      env: process.env.NODE_ENV || 'development'
    };

    // Determine overall health status
    const isonline = dbStatus.connected && socketStatus.connected;
    const status = isonline ? 'online' : 'degraded';

    // Return health information
    res.status(200).json({
      status,
      timestamp: new Date().toISOString(),
      checks: {
        database: dbStatus,
        socket: socketStatus
      },
      system: systemInfo
    });
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(500).json({
      status: 'offline',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Check database connection
 */
async function checkDatabase() {
  try {
    await sequelize.authenticate();
    return {
      connected: true,
      message: 'Database connection successful'
    };
  } catch (error) {
    return {
      connected: false,
      message: error instanceof Error ? error.message : 'Database connection failed'
    };
  }
}

/**
 * Check socket server status
 */
function checkSocketServer() {
  try {
    const io = getIO();
    return {
      connected: io !== null,
      message: io !== null ? 'Socket server is running' : 'Socket server is not initialized'
    };
  } catch (error) {
    return {
      connected: false,
      message: error instanceof Error ? error.message : 'Socket server check failed'
    };
  }
}

export default router;
