import express, {Express} from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import {createServer} from 'http';
import {Server} from 'socket.io';
import adminRoutes from './routes/admin/index.js';
import authRoutes from './routes/auth/index.js';
import mediaRoutes from './routes/misc/media.js';
import formRoutes from './routes/misc/form.js';
import databaseRoutes from './routes/database/index.js';
import webhookRoutes from './routes/webhooks/index.js';
import db from './models/index.js';
import {setIO} from './utils/socket.js';
import {htmlMetaMiddleware} from './middleware/html-meta.js';
import path from 'path';
import discordRouter from './routes/misc/discord.js';
import eventsRouter from './routes/misc/events.js';
import utilsRouter from './routes/misc/utils.js';
import chunkedUploadRouter from './routes/misc/chunkedUpload.js';
import {PlayerStatsService} from './services/PlayerStatsService.js';
import {fileURLToPath} from 'url';
import healthRouter from './routes/misc/health.js';
import { logger } from './services/LoggerService.js';
import ElasticsearchService from './services/ElasticsearchService.js';
import { clientUrlEnv, port, ownUrl, corsOptions } from './config/app.config.js';
// Add these at the very top of the file, before any other imports
process.on('uncaughtException', (error) => {
  logger.error('UNCAUGHT EXCEPTION! Shutting down...');
  logger.error(error.message);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('UNHANDLED REJECTION! Shutting down...');
  logger.error('Reason:', reason);
  logger.error('Promise:', JSON.stringify(promise));
});

// Add a handler for SIGTERM and SIGINT
process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  // Perform cleanup
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received. Shutting down gracefully...');
  // Perform cleanup
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
    logger.info('Socket disconnected:', reason);
  });
});

// Initialize database and start server
export async function startServer() {
  try {
    // First, verify database connection
    await db.sequelize.authenticate();

    if (process.env.INIT_DB === 'true'){
      await db.sequelize.sync({force: true});
    }

    logger.info('Database connection established.');

    // Initialize Elasticsearch
    try {
      logger.info('Starting Elasticsearch initialization...');
      const elasticsearchService = ElasticsearchService.getInstance();
      await elasticsearchService.initialize();
      logger.info('Elasticsearch initialization completed');
    } catch (error) {
      logger.error('Error initializing Elasticsearch:', error);
      // Don't throw here, allow the app to start even if Elasticsearch fails
      // The search functionality will fall back to MySQL in this case
      logger.warn('Application will continue without Elasticsearch functionality');
    }

    // Initialize PlayerStatsService after database is ready
    const playerStatsService = PlayerStatsService.getInstance();
    await playerStatsService.initialize();

    // Enable pre-flight requests for all routes
    app.options('*', cors(corsOptions));

    // Apply CORS middleware to all routes
    app.use(cors(corsOptions));

    app.use(express.json());
    app.use(express.urlencoded({extended: true}));

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
    // HTML meta tags middleware for specific routes BEFORE static files
    app.get(['/passes/:id', '/levels/:id', '/player/:id'], htmlMetaMiddleware);

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

    // Start the server
    await new Promise<void>(resolve => {
      httpServer.listen(Number(port), '127.0.0.1', () => {
        logger.info(
          `Server running on ${ownUrl} (${process.env.NODE_ENV} environment)`,
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
