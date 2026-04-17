import express from 'express';
import fs from 'fs';
import cors from 'cors';
import { logger } from '@/server/services/core/LoggerService.js';
import { CDN_CONFIG } from './config.js';
import router from './routes/index.js';
import dotenv from 'dotenv';
import { registerGlobalProcessHandlers } from '@/server/bootstrap/processHandlers.js';
import { sweepWorkspaceRootOnBoot } from '@/server/services/core/WorkspaceService.js';
dotenv.config();

registerGlobalProcessHandlers();

// Boot-time stale workspace sweep for the CDN process (separate PID, same root).
// eslint-disable-next-line @typescript-eslint/no-floating-promises
sweepWorkspaceRootOnBoot();

const app = express();

// Ensure CDN root directory exists
if (!fs.existsSync(CDN_CONFIG.localRoot)) {
    fs.mkdirSync(CDN_CONFIG.localRoot, { recursive: true });
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
