import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';
import adminRoutes from './routes/admin/index';
import leaderboardRoutes from './routes/leaderboard';
import playerRoutes from './routes/player';
import authRoutes from './routes/auth';
import mediaRoutes from './routes/media';
import formRoutes from './routes/form';
import databaseRoutes from './routes/database/index';
import connectDB from './config/db';
import { startScheduledTasks } from './utils/scheduledTasks';
import { updateData } from './utils/updateHelpers';
import reloadDatabase from './utils/reloadDatabase';
import { setIO } from './utils/socket';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const port = process.env.PORT || 3002;

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

connectDB();

app.use(cors());


app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/v2/admin', adminRoutes);
app.use('/v2/form', formRoutes);
app.use('/v2/leaderboard', leaderboardRoutes);
app.use('/v2/player', playerRoutes);
app.use('/v2/auth', authRoutes);
app.use('/v2/media', mediaRoutes);
app.use('/v2/data', databaseRoutes);


httpServer.listen(port, async () => {
  //await reloadDatabase();
  updateData();
  startScheduledTasks();
  console.log(`Server running on ${process.env.OWN_URL}`);
});