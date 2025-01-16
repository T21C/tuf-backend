import express, {Express} from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import {createServer} from 'http';
import {Server} from 'socket.io';
import adminRoutes from './routes/admin/index';
import authRoutes from './routes/auth';
import mediaRoutes from './routes/media';
import formRoutes from './routes/form';
import databaseRoutes from './routes/database/index';
import webhookRoutes from './routes/webhooks/index';
import db from './models/index';
import initializeDatabase from './utils/initializeDatabase';
import {setIO} from './utils/socket';
import {updateAllPlayerPfps} from './utils/PlayerEnricher';
import {Cache} from './middleware/cache';
import {htmlMetaMiddleware} from './middleware/html-meta';
import Pass from './models/Pass';
import Level from './models/Level';
import Difficulty from './models/Difficulty';
import path from 'path';
import fs from 'fs';
import discordRouter from './routes/discord';
import eventsRouter from './routes/events';
import utilsRouter from './routes/utils';
import reloadDatabase, { partialReload } from './utils/reloadDatabase';
import {PlayerStatsService} from './services/PlayerStatsService';

dotenv.config();

const app: Express = express();
const httpServer = createServer(app);

// Get environment-specific configuration
const isStaging = process.env.NODE_ENV === 'staging';
const clientUrl = isStaging ? process.env.STAGING_CLIENT_URL : process.env.CLIENT_URL;
const port = isStaging ? process.env.STAGING_PORT : process.env.PORT;
const ownUrl = isStaging ? process.env.STAGING_API_URL : process.env.OWN_URL;

// Create Socket.IO instance
const io = new Server(httpServer, {
  cors: {
    origin: clientUrl || 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

setIO(io);

// Socket connection handler
io.on('connection', socket => {
  console.log('Client connected:', socket.id);

  socket.on('disconnect', reason => {
    console.log('Client disconnected:', socket.id, 'Reason:', reason);
  });
});

// Initialize database and start server
async function startServer() {
  try {
    // First, verify database connection
    await db.sequelize.authenticate();
    console.log('Database connection established.');

    // Then initialize if needed
    if (process.env.INIT_DB === 'true') {
      console.log('Initializing database...');
      await initializeDatabase();
      // Add a delay after initialization to ensure all transactions are complete
      console.log("Waiting for 5 seconds before proceeding with PFP updates...");
      await new Promise(resolve => setTimeout(resolve, 5000));
      console.log('Database initialization complete, proceeding with PFP updates...');
    }
    else if (process.env.UPDATE_DB === 'true') {
      console.log('Updating database...');
      await partialReload();
      // Add a delay after update to ensure all transactions are complete
      console.log("Waiting for 5 seconds before proceeding with PFP updates...");
      await new Promise(resolve => setTimeout(resolve, 5000));
      console.log('Database update complete, proceeding with PFP updates...');
    }

    // Initialize PlayerStatsService after database is ready
    const playerStatsService = PlayerStatsService.getInstance();
    await playerStatsService.initialize();

    // Set up Express middleware
    const corsOptions = {
      origin: clientUrl || 'http://localhost:5173',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD', 'CONNECT', 'TRACE'],
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'Last-Event-ID', 'X-Form-Type'],
      exposedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'Last-Event-ID', 'X-Form-Type']
    };

    // Enable pre-flight requests for all routes
    app.options('*', cors(corsOptions));

    // Apply CORS middleware to all routes
    app.use(cors(corsOptions));
    
    app.use(express.json());
    app.use(express.urlencoded({extended: true}));
    app.use(Cache.leaderboard());
    console.log('Cache middleware attached');

    // HTML meta tags middleware for specific routes
    app.get('/passes/:id', htmlMetaMiddleware);
    app.get('/levels/:id', htmlMetaMiddleware);
    app.get('/player/:id', htmlMetaMiddleware);

    // Set up API routes
    app.use('/v2/admin', adminRoutes);
    app.use('/v2/form', formRoutes);
    app.use('/v2/auth', authRoutes);
    app.use('/v2/media', mediaRoutes);
    app.use('/v2/database', databaseRoutes());
    app.use('/v2/webhook', webhookRoutes);
    app.use('/v2/discord', discordRouter);
    app.use('/events', eventsRouter);
    app.use('/v2/utils', utilsRouter);
    app.get('/', (req, res) => {
      res.send(fs.readFileSync(path.join('src', 'index.html'), 'utf8'));
    });

    // Start the server
    await new Promise<void>(resolve => {
      httpServer.listen(Number(port), '127.0.0.1', () => {
        console.log(`Server running on ${ownUrl} (${process.env.NODE_ENV} environment)`);
        resolve();
      });
    });

    // Initialize leaderboard cache through middleware
    try {
      await Cache.leaderboard().initialize?.();
      console.log('Cache initialization completed successfully');
    } catch (cacheError) {
      console.error('Error during cache initialization:', cacheError);
    }

    // Update profile pictures after server is fully initialized and database operations are complete
    console.log('Starting profile picture updates...');
    try {
      await updateAllPlayerPfps();
      console.log('Player profile pictures updated successfully');
    } catch (pfpError) {
      console.error('Error updating profile pictures:', pfpError);
    }

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
