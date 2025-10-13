import express from 'express';
import fs from 'fs';
import cors from 'cors';
import { logger } from '../services/LoggerService.js';
import { CDN_CONFIG } from './config.js';
import router from './routes/index.js';
import dotenv from 'dotenv';
dotenv.config();

const app = express();

// Global error handlers
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
    });
    // Give time for logging before exiting
    setTimeout(() => {
        process.exit(1);
    }, 1000);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection:', {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
        promise
    });
});

// Ensure CDN root directory exists
if (!fs.existsSync(CDN_CONFIG.user_root)) {
    fs.mkdirSync(CDN_CONFIG.user_root, { recursive: true });
}

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// Global error handling middleware
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.error('Express error:', {
        error: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method
    });

    res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

app.use('/', router);

app.listen(CDN_CONFIG.port, () => {
    logger.info(`CDN service running on port ${CDN_CONFIG.port}`);
});

export default app;
