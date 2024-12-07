import express, { Express } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';
import adminRoutes from './routes/admin/index';
import authRoutes from './routes/auth';
import mediaRoutes from './routes/media';
import formRoutes from './routes/form';
import databaseRoutes from './routes/database/index';
import db from './models/index';
import initializeDatabase from './utils/initializeDatabase';
import { startScheduledTasks } from './utils/scheduledTasks';
import { updateData } from './utils/updateHelpers';
import reloadDatabase from './utils/reloadDatabase';
import { setIO } from './utils/socket';

dotenv.config();

const app: Express = express(); 
const httpServer = createServer(app);

// Create Socket.IO instance
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

setIO(io);

// Socket connection handler
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('disconnect', (reason) => {
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
      console.log('Initializing database structure...');
      await initializeDatabase();

      console.log('Reloading database...');
      await reloadDatabase();
    }

    // Set up Express middleware
    app.use(cors());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Set up routes
    app.use('/v2/admin', adminRoutes);
    app.use('/v2/form', formRoutes);
    app.use('/v2/auth', authRoutes);
    app.use('/v2/media', mediaRoutes);
    app.use('/v2/data', databaseRoutes);

    // Start the server
    const port = process.env.PORT || 3002;
    httpServer.listen(port, () => {
      console.log(`Server running on ${process.env.OWN_URL}`);
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle uncaught errors
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

// Start the server
startServer();

export default app;