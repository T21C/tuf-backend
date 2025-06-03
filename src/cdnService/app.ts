import express from 'express';
import fs from 'fs';
import cors from 'cors';
import { logger } from '../services/LoggerService.js';
import { CDN_CONFIG } from './config.js';
import router from './routes/index.js';
import dotenv from 'dotenv';
dotenv.config();

const app = express();

// Ensure CDN root directory exists
if (!fs.existsSync(CDN_CONFIG.root)) {
    fs.mkdirSync(CDN_CONFIG.root, { recursive: true });
}

// Middleware
app.use(cors({
    origin: "*",
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());

app.use('/', router);

app.listen(CDN_CONFIG.port, () => {
    logger.info(`CDN service running on port ${CDN_CONFIG.port}`);
}); 

export default app; 