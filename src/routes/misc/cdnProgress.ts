import { Router, Request, Response } from 'express';
import { getIO } from '../../utils/server/socket.js';
import { logger } from '../../services/LoggerService.js';

const router = Router();

interface PackProgressPayload {
    downloadId: string;
    cacheKey: string;
    status: 'pending' | 'processing' | 'zipping' | 'uploading' | 'completed' | 'failed';
    totalLevels: number;
    processedLevels: number;
    currentLevel?: string;
    progressPercent: number;
    error?: string;
}

// POST /v2/cdn/pack-progress - Receive progress updates from CDN service
router.post('/pack-progress', async (req: Request, res: Response) => {
    try {
        const payload = req.body as PackProgressPayload;

        // Validate payload
        if (!payload.downloadId || !payload.cacheKey || !payload.status) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Emit progress via Socket.IO to all connected clients
        const io = getIO();
        io.emit('packDownloadProgress', payload);

        logger.debug('Forwarded pack download progress', {
            downloadId: payload.downloadId,
            status: payload.status,
            progressPercent: payload.progressPercent
        });

        return res.status(200).json({ success: true });
    } catch (error) {
        logger.error('Failed to handle pack progress update', {
            error: error instanceof Error ? error.message : String(error)
        });
        return res.status(500).json({ error: 'Failed to process progress update' });
    }
});

export default router;
