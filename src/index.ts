import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import adminRoutes from './routes/admin';
import leaderboardRoutes from './routes/leaderboard';
import playerRoutes from './routes/player';
import authRoutes from './routes/auth';
import mediaRoutes from './routes/media';
import formRoutes from './routes/form';
import connectDB from './config/db';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

connectDB();

app.use(cors());

app.use(express());
app.use(express.urlencoded({extended: true}));

app.use('/api/admin', adminRoutes);
app.use('/api/form', formRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/player', playerRoutes);
app.use('/api/auth', authRoutes);
app.use('/media', mediaRoutes);

app.listen(port, () => {
  console.log(`Server running on ${process.env.OWN_URL}`);
});
