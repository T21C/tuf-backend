import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
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

dotenv.config();

const app = express();
const port = process.env.PORT || 3002;

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


app.listen(port, () => {
  updateData();
  startScheduledTasks();
  console.log(`Server running on ${process.env.OWN_URL}`);
});