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

dotenv.config();

const app: Express = express();
const httpServer = createServer(app);

// Create Socket.IO instance
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
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
    }

    // Set up Express middleware
    const corsOptions = {
      origin: process.env.CLIENT_URL || 'http://localhost:5173',
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
    app.use('/v2/data', databaseRoutes());
    app.use('/v2/webhook', webhookRoutes);
    app.use('/v2/discord', discordRouter);
    app.use('/events', eventsRouter);
    app.use('/v2/utils', utilsRouter);
    app.get('/', (req, res) => {
      res.send(fs.readFileSync(path.join('src', 'index.html'), 'utf8'));
    });

    // Start the server
    const port = process.env.PORT || 3002;
    await new Promise<void>(resolve => {
      httpServer.listen(port, () => {
        console.log(`Server running on ${process.env.OWN_URL}`);
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

    // Update profile pictures after server is fully initialized
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
