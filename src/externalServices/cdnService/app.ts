import '@/config/db.js';
import express from 'express';
import fs from 'fs';
import cors from 'cors';
import { logger } from '@/server/services/core/LoggerService.js';
import { CDN_CONFIG } from './config.js';
import router from './routes/index.js';
import dotenv from 'dotenv';
import { registerGlobalProcessHandlers } from '@/server/bootstrap/processHandlers.js';
import { sweepWorkspaceRootOnBoot } from '@/server/services/core/WorkspaceService.js';
import { cdnLocalTemp } from './infra/workspaces/cdnLocalTempManager.js';
import { spacesStorage } from './infra/storage/spacesStorage.js';
import { setTerminalServiceTitle } from '@/misc/utils/terminalTitle.js';

dotenv.config();

setTerminalServiceTitle('TUF CDN');
registerGlobalProcessHandlers();

// Boot-time stale workspace sweep for the CDN process (separate PID, same root).
// eslint-disable-next-line @typescript-eslint/no-floating-promises
sweepWorkspaceRootOnBoot();

// Boot-time sweep of the multer upload directory (`<localRoot>/temp`). Catches
// `<uuid>.zip` leftovers from previous SIGKILL / crash mid-upload — multer
// writes the file before any route handler runs, so it can't live in a workspace.
// eslint-disable-next-line @typescript-eslint/no-floating-promises
cdnLocalTemp.sweepUploadTempOnBoot();

// Public-read CORS on R2 so browser fetch can read objects after 301 redirects.
// eslint-disable-next-line @typescript-eslint/no-floating-promises
spacesStorage.ensurePublicReadCors().catch((error) => {
    logger.error('Failed to configure R2 public-read CORS', {
        error: error instanceof Error ? error.message : String(error),
    });
});

const app = express();

// Ensure CDN root directory exists
if (!fs.existsSync(CDN_CONFIG.localRoot)) {
    fs.mkdirSync(CDN_CONFIG.localRoot, { recursive: true });
}

// Public CORS for browser asset delivery (img fetch, download-all zip, etc.).
// Write routes stay server-to-server and are gated by requireCdnIngestKey.
const publicReadCors = cors({
    origin: '*',
    methods: ['GET', 'HEAD', 'OPTIONS'],
    allowedHeaders: '*',
});
app.use((req, res, next) => {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        return publicReadCors(req, res, next);
    }
    next();
});
app.use(express.json());

// Cheap liveness probe target for the standalone health service. Mounted
// before the main router so it can't be blocked by heavy upload/parse routes
// or any future middleware that touches the DB.
app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'cdn' });
});

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
