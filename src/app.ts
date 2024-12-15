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

dotenv.config();

const gato = process.env.OWN_URL + '/v2/media/image/soggycat.webp';
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
    app.use(cors());
    app.use(express.json());
    app.use(express.urlencoded({extended: true}));
    console.log('Initializing cache middleware...');
    app.use(Cache.leaderboard());
    console.log('Cache middleware attached');

    // Set up routes
    app.use('/v2/admin', adminRoutes);
    app.use('/v2/form', formRoutes);
    app.use('/v2/auth', authRoutes);
    app.use('/v2/media', mediaRoutes);
    app.use('/v2/data', databaseRoutes());
    app.use('/v2/webhook', webhookRoutes);
    app.get('/', (req, res) => {
      res.send(
        '<img src="' + gato + '" style="width: 50%; height: 50%;" alt="">',
      );
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
    console.log('Starting cache initialization...');
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
