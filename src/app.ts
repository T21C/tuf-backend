import express, {Express, Request, Response, NextFunction} from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import {createServer} from 'http';
import {Server} from 'socket.io';
import adminRoutes from './server/routes/admin/index.js';
import authRoutes from './server/routes/auth/index.js';
import mediaRoutes from './server/routes/misc/media.js';
import formRoutes from './server/routes/misc/form.js';
import databaseRoutes from './server/routes/database/index.js';
import webhookRoutes from './server/routes/webhooks/index.js';
import db from './models/index.js';
import {setIO} from './misc/utils/server/socket.js';
import {htmlMetaMiddleware} from './server/middleware/html-meta.js';
import path from 'path';
import discordRouter from './server/routes/misc/discord.js';
import eventsRouter from './server/routes/misc/events.js';
import utilsRouter from './server/routes/misc/utils.js';
import chunkedUploadRouter from './server/routes/misc/chunkedUpload.js';
import cdnProgressRouter from './server/routes/misc/cdnProgress.js';
import {PlayerStatsService} from './server/services/PlayerStatsService.js';
import {fileURLToPath} from 'url';
import healthRouter from './server/routes/misc/health.js';
import { logger } from './server/services/LoggerService.js';
import ElasticsearchService from './server/services/ElasticsearchService.js';
import { clientUrlEnv, port, corsOptions } from './config/app.config.js';
import { startConnectionMonitoring } from './config/db.js';
import { initializeDefaultPools } from './config/poolConfig.js';
import { redis } from './server/services/RedisService.js';
initializeDefaultPools();

// Add these at the very top of the file, before any other imports
process.on('uncaughtException', (error: any) => {
  // Handle connection reset errors gracefully - these are common when clients disconnect
  if (error.code === 'ECONNRESET' || error.code === 'EPIPE') {
    logger.warn('Client disconnected during operation:', {
      code: error.code,
      message: error.message,
      syscall: error.syscall
    });
    // Don't shut down for client disconnects - these are expected
    return;
  }

  // For other uncaught exceptions, log and continue (don't shut down)
  logger.error('UNCAUGHT EXCEPTION:', {
    message: error.message,
    code: error.code,
    syscall: error.syscall,
    stack: error.stack
  });
});

// CRITICAL: This handler ensures unhandled rejections NEVER exit the application
// All errors are logged but the application continues running
process.on('unhandledRejection', (reason: any, promise) => {
  // Handle connection reset errors gracefully
  if (reason && (reason.code === 'ECONNRESET' || reason.code === 'EPIPE')) {
    logger.warn('Client disconnected (unhandled rejection):', {
      code: reason.code,
      message: reason.message,
      syscall: reason.syscall
    });
    return; // Don't treat client disconnects as critical errors
  }

  // Handle database connection errors gracefully
  // Sequelize will attempt to reconnect automatically on next query
  if (reason && (
    reason.code === 'ECONNREFUSED' || 
    reason.code === 'PROTOCOL_CONNECTION_LOST' || 
    reason.code === 'ETIMEDOUT' ||
    (reason.name === 'SequelizeConnectionRefusedError') ||
    (reason.name === 'SequelizeConnectionError') ||
    (reason.name === 'SequelizeConnectionAcquireTimeoutError')
  )) {
    logger.warn('Database connection error (unhandled rejection):', {
      code: reason.code || reason.name,
      message: reason.message,
      note: 'Sequelize will attempt to reconnect automatically on next query'
    });
    return; // Don't treat database connection errors as critical - Sequelize handles reconnection
  }

  // Check if it's a transaction rollback error and handle it gracefully
  if (reason instanceof Error && reason.message.includes('Transaction cannot be rolled back')) {
    logger.warn('Transaction rollback error detected - this is likely a duplicate rollback call');
    return; // Don't treat this as a critical error
  }

  // For other unhandled rejections, log but don't shut down
  logger.error('UNHANDLED REJECTION! Logging error but continuing...');
  logger.error('Reason:', reason);
  logger.error('Promise:', promise);
  logger.error('Stack trace:', reason instanceof Error ? reason.stack : 'No stack trace available');
  // Explicitly prevent process exit - application will continue running
  return;
});

// Handle Node.js warnings - filter out known non-critical warnings
process.on('warning', (warning) => {
  // Suppress TimeoutNegativeWarning - this happens when cron jobs overlap
  // and try to schedule in the past. The cron library handles this by setting to 1ms.
  if (warning.name === 'TimeoutNegativeWarning') {
    logger.debug('Cron job scheduling adjustment (overlapping executions)');
    return;
  }

  // Log all other warnings normally
  logger.warn('Node.js Warning:', warning);
});

// Add a handler for SIGTERM and SIGINT
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  await redis.disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received. Shutting down gracefully...');
  await redis.disconnect();
  process.exit(0);
});

dotenv.config();

const app: Express = express();
const httpServer = createServer(app);

// Trust proxy headers for proper IP address handling
app.set('trust proxy', true);

// ES Module dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create Socket.IO instance
const io = new Server(httpServer, {
  cors: {
    origin: [
      clientUrlEnv || 'http://localhost:5173',
      'https://tuforums.com',
      'https://api.tuforums.com',
    ],
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

setIO(io);

// Socket connection handler
io.on('connection', socket => {
  socket.on('disconnect', reason => {
    logger.debug('Socket disconnected:', reason);
  });
});

// Initialize database and start server
export async function startServer() {
  try {
    // First, verify database connection
    await db.sequelize.authenticate();

    if (process.env.INIT_DB === 'true'){
      logger.info('Initializing database...');
      await db.sequelize.sync({force: true});
    }
    startConnectionMonitoring();

    logger.info('Database connection established.');

    // Initialize Redis
    try {
      logger.info('Connecting to Redis...');
      await redis.connect();
    } catch (error) {
      logger.error('Error connecting to Redis:', error);
      logger.warn('Application will continue without Redis caching');
    }

    // Initialize Elasticsearch
    try {
      logger.info('Starting Async Elasticsearch initialization...');
      const elasticsearchService = ElasticsearchService.getInstance();
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      elasticsearchService.initialize();
    } catch (error) {
      logger.error('Error initializing Elasticsearch:', error);
      // Don't throw here, allow the app to start even if Elasticsearch fails
      // The search functionality will fall back to MySQL in this case
      logger.warn('Application will continue without Elasticsearch functionality');
    }

    // Initialize PlayerStatsService after database is ready
    const playerStatsService = PlayerStatsService.getInstance();
    // speed up initialization
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    playerStatsService.initialize();

    // Enable pre-flight requests for all routes
    app.options('*', cors(corsOptions));

    // Apply CORS middleware to all routes
    app.use(cors(corsOptions));

    app.use(express.json());
    app.use(express.urlencoded({extended: true}));

    // Response time logging middleware - logs slow endpoints
    const SLOW_ENDPOINT_THRESHOLD_MS = process.env.SLOW_ENDPOINT_THRESHOLD_MS ? parseInt(process.env.SLOW_ENDPOINT_THRESHOLD_MS) : 3000;
    // Endpoints excluded from slow logging (supports wildcards with *)
    const SLOW_LOG_EXCLUDED_ROUTES = [
      '/v2/webhook/*',
      '/v2/form/form-submit',
      '/v2/media/thumbnail/*',
      '/v2/media/image-proxy',   // Thumbnail generation is expected to be slow
      '/v2/chunked-upload/*',    // File uploads are expected to be slow
      '/health',                 // Health checks are lightweight, no need to log
    ];

    const isExcludedRoute = (path: string): boolean => {
      return SLOW_LOG_EXCLUDED_ROUTES.some(pattern => {
        if (pattern.includes('*')) {
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
          return regex.test(path);
        }
        return path === pattern;
      });
    };

    app.use((req: Request, res: Response, next: NextFunction) => {
      const start = process.hrtime.bigint();
      const path = req.originalUrl.split('?')[0]; // Strip query params
      const route = `${req.method} ${path}`;

      res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
        if (durationMs > SLOW_ENDPOINT_THRESHOLD_MS && !isExcludedRoute(path)) {
          logger.warn(`Slow endpoint (${durationMs.toFixed(0)}ms): ${route}`, {
            status: res.statusCode,
            duration: Math.round(durationMs),
            userId: (req as any).user?.id,
            query: Object.keys(req.query).length > 0 ? req.query : undefined
          });
        }
      });

      next();
    });

    // Set up API routes first
    app.use('/v2/admin', adminRoutes);
    app.use('/v2/form', formRoutes);
    app.use('/v2/auth', authRoutes);
    app.use('/v2/media', mediaRoutes);
    app.use('/v2/database', databaseRoutes());
    app.use('/v2/webhook', webhookRoutes);
    app.use('/v2/discord', discordRouter);
    app.use('/events', eventsRouter);
    app.use('/v2/utils', utilsRouter);
    app.use('/health', healthRouter);
    app.use('/v2/chunked-upload', chunkedUploadRouter);
    app.use('/v2/cdn', cdnProgressRouter);
    // HTML meta tags middleware for specific routes BEFORE static files
    app.get(['/passes/:id', '/levels/:id', '/profile/:id', '/packs/:id'], htmlMetaMiddleware);

    // Handle static files and SPA routing
    const clientBuildPath =
      process.env.NODE_ENV === 'production'
        ? path.join(__dirname, '../../client/dist')
        : path.join(__dirname, '../../client/dist');

    // Serve static assets (but not index.html)
    app.use(
      express.static(clientBuildPath, {
        index: false,
        // Only serve files from the assets directory
        setHeaders: (res, filePath) => {
          if (filePath.includes('/assets/')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000');
          }
        },
      }),
    );

    // Handle remaining HTML requests
    app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'index.html'));
    });
    app.get('*', (req, res) => {
      return res.status(404).sendFile(path.join(__dirname, 'notFound.html'));
    });

    // Global error handling middleware - must be last
// eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((err: any, req: Request, res: Response, next: NextFunction) => {
      // Handle connection reset errors gracefully
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
        // Client disconnected - don't send response if headers already sent
        if (!res.headersSent) {
          return res.status(499).json({
            error: 'Client disconnected'
          });
        }
        // Headers already sent, just log and return
        logger.debug('Client disconnected during response:', {
          code: err.code,
          path: req.path,
          method: req.method
        });
        return;
      }

      // Handle URI decoding errors specifically
      if (err instanceof URIError) {
        logger.debug('URI decoding error:', {
          error: err.message,
          path: req.path,
          method: req.method,
          ip: req.connection.remoteAddress || req.ip
        });

        return res.status(400).json({
          error: 'Invalid URL encoding',
          message: 'The requested URL contains invalid characters'
        });
      }

      // Handle other Express errors
      if (!err.skipLogging) {
        logger.error('Express error:', {
          error: err.message || err.error,
          code: err.code,
          stack: err.stack,
          path: req.path,
          method: req.method,
          ip: req.ip
        });
      }

      // Only send error response if headers haven't been sent
      if (!res.headersSent) {
        return res.status(500).json({
          error: 'Internal server error',
          message: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
      }
      return
    });

    // Start the server
    const bindAddress = process.env.BIND_ADDRESS || '127.0.0.1';
    await new Promise<void>(resolve => {
      httpServer.listen(Number(port), bindAddress, () => {
        logger.info(
          `Server running on ${bindAddress}:${port} (${process.env.NODE_ENV} environment)`,
        );
        resolve();
      });
    });

  } catch (error) {
    logger.error('Failed to start server:', error);
    throw error;
  }
}

// Start the server
startServer().catch(error => {
  logger.error('Failed to start server:', error);
  throw error;
});

export default app;
