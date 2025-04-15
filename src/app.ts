import express, {Express} from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import {createServer} from 'http';
import {Server} from 'socket.io';
import adminRoutes from './routes/admin/index.js';
import authRoutes from './routes/auth/index.js';
import mediaRoutes from './routes/media.js';
import formRoutes from './routes/form.js';
import databaseRoutes from './routes/database/index.js';
import webhookRoutes from './routes/webhooks/index.js';
import db from './models/index.js';
import {setIO} from './utils/socket.js';
import {htmlMetaMiddleware} from './middleware/html-meta.js';
import path from 'path';
import fs from 'fs';
import discordRouter from './routes/discord.js';
import eventsRouter from './routes/events.js';
import utilsRouter from './routes/utils.js';
import {PlayerStatsService} from './services/PlayerStatsService.js';
import {fileURLToPath} from 'url';

dotenv.config();

const app: Express = express();
const httpServer = createServer(app);

// Trust proxy headers for proper IP address handling
app.set('trust proxy', true);

// ES Module dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get environment-specific configuration
const clientUrlEnv =
  process.env.NODE_ENV === 'production'
    ? process.env.PROD_CLIENT_URL
    : process.env.NODE_ENV === 'staging'
      ? process.env.STAGING_CLIENT_URL
      : process.env.NODE_ENV === 'development'
        ? process.env.CLIENT_URL
        : 'http://localhost:5173';

const port =
  process.env.NODE_ENV === 'production'
    ? process.env.PROD_PORT
    : process.env.NODE_ENV === 'staging'
      ? process.env.STAGING_PORT
      : process.env.NODE_ENV === 'development'
        ? process.env.PORT
        : '3002';

const ownUrl =
  process.env.NODE_ENV === 'production'
    ? process.env.PROD_API_URL
    : process.env.NODE_ENV === 'staging'
      ? process.env.STAGING_API_URL
      : process.env.NODE_ENV === 'development'
        ? process.env.DEV_URL
        : 'http://localhost:3002';

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
    console.log('Socket disconnected:', reason);
  });
});

// Initialize database and start server
async function startServer() {
  try {
    // First, verify database connection
    await db.sequelize.authenticate();

    if (process.env.INIT_DB === 'true'){
      await db.sequelize.sync({force: true});
    }

    console.log('Database connection established.');

    // Initialize PlayerStatsService after database is ready
    const playerStatsService = PlayerStatsService.getInstance();
    await playerStatsService.initialize();

    // Set up Express middleware
    const corsOptions = {
      origin: [
        clientUrlEnv || 'http://localhost:5173',
        'https://tuforums.com',
        'https://api.tuforums.com',
        'https://4p437dcj-5173.eun1.devtunnels.ms',
        'https://4p437dcj-3002.eun1.devtunnels.ms',
      ],
      methods: [
        'GET',
        'POST',
        'PUT',
        'DELETE',
        'OPTIONS',
        'PATCH',
        'HEAD',
        'CONNECT',
        'TRACE',
      ],
      credentials: true,
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'Cache-Control',
        'Last-Event-ID',
        'X-Form-Type',
        'X-Super-Admin-Password',
      ],
      exposedHeaders: [
        'Content-Type',
        'Authorization',
        'Cache-Control',
        'Last-Event-ID',
        'X-Form-Type',
        'X-Super-Admin-Password',
      ],
    };

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
        console.log(
          `Server running on ${ownUrl} (${process.env.NODE_ENV} environment)`,
        );
        resolve();
      });
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    throw error;
  }
}

// Handle uncaught errors
process.on('unhandledRejection', error => {
  console.error('Unhandled rejection:', error);
});

process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error);
  throw error;
});

// Start the server
startServer().catch(error => {
  console.error('Failed to start server:', error);
  throw error;
});

export default app;
