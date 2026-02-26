import { Router, Request, Response } from 'express';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { errorResponseSchema, standardErrorResponses500 } from '@/server/schemas/v2/misc/index.js';
import { sseManager } from '@/misc/utils/server/sse.js';
import { logger } from '@/server/services/LoggerService.js';

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

interface LevelUploadProgressPayload {
    uploadId: string;
    status: 'uploading' | 'processing' | 'caching' | 'completed' | 'failed';
    progressPercent: number;
    currentStep?: string;
    error?: string;
}

// POST /v2/cdn/pack-progress - Receive progress updates from CDN service
router.post(
    '/pack-progress',
    ApiDoc({
        operationId: 'postCdnPackProgress',
        summary: 'Report pack download progress',
        description: 'Called by CDN service to push pack download progress to SSE subscribers (packDownload:{downloadId}).',
        tags: ['CDN'],
        requestBody: {
            description: 'Pack download progress payload',
            schema: {
                type: 'object',
                required: ['downloadId', 'cacheKey', 'status'],
                properties: {
                    downloadId: { type: 'string' },
                    cacheKey: { type: 'string' },
                    status: { type: 'string', enum: ['pending', 'processing', 'zipping', 'uploading', 'completed', 'failed'] },
                    totalLevels: { type: 'number' },
                    processedLevels: { type: 'number' },
                    currentLevel: { type: 'string' },
                    progressPercent: { type: 'number' },
                    error: { type: 'string' },
                },
            },
            required: true,
        },
        responses: {
            200: { description: 'Progress forwarded to SSE', schema: { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] } },
            400: { description: 'Missing required fields', schema: errorResponseSchema },
            500: { description: 'Failed to process update', schema: errorResponseSchema },
        },
    }),
    async (req: Request, res: Response) => {
    try {
        const payload = req.body as PackProgressPayload;

        // Validate payload
        if (!payload.downloadId || !payload.cacheKey || !payload.status) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Send progress to clients subscribed to this specific download
        const source = `packDownload:${payload.downloadId}`;
        sseManager.sendToSource(source, {
            type: 'packDownloadProgress',
            data: payload
        });

        logger.debug('Sent pack download progress via SSE to source', {
            source,
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
    }
);

// POST /v2/cdn/level-upload-progress - Receive progress updates from CDN service for level uploads
router.post(
    '/level-upload-progress',
    ApiDoc({
        operationId: 'postCdnLevelUploadProgress',
        summary: 'Report level upload progress',
        description: 'Called by CDN service to push level upload progress to SSE subscribers (levelUpload:{uploadId}).',
        tags: ['CDN'],
        requestBody: {
            description: 'Level upload progress payload',
            schema: {
                type: 'object',
                required: ['uploadId', 'status'],
                properties: {
                    uploadId: { type: 'string' },
                    status: { type: 'string', enum: ['uploading', 'processing', 'caching', 'completed', 'failed'] },
                    progressPercent: { type: 'number' },
                    currentStep: { type: 'string' },
                    error: { type: 'string' },
                },
            },
            required: true,
        },
        responses: {
            200: { description: 'Progress forwarded to SSE', schema: { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] } },
            400: { description: 'Missing required fields', schema: errorResponseSchema },
            500: { description: 'Failed to process update', schema: errorResponseSchema },
        },
    }),
    async (req: Request, res: Response) => {
    try {
        const payload = req.body as LevelUploadProgressPayload;

        // Validate payload
        if (!payload.uploadId || !payload.status) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Send progress to clients subscribed to this specific upload
        const source = `levelUpload:${payload.uploadId}`;
        sseManager.sendToSource(source, {
            type: 'levelUploadProgress',
            data: payload
        });

        return res.status(200).json({ success: true });
    } catch (error) {
        logger.error('Failed to handle level upload progress update', {
            error: error instanceof Error ? error.message : String(error)
        });
        return res.status(500).json({ error: 'Failed to process progress update' });
    }
    }
);

export default router;

