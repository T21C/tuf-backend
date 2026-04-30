import { logger } from '@/server/services/core/LoggerService.js';
import { CDN_CONFIG } from '@/externalServices/cdnService/config.js';
import { processZipFile } from '@/externalServices/cdnService/services/zipProcessor.js';
import { Request, Response, Router } from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { cdnLocalTemp } from '@/externalServices/cdnService/infra/workspaces/cdnLocalTempManager.js';

const router = Router();

function getMainServerUrl(): string {
    if (process.env.NODE_ENV === 'production') {
        return process.env.PROD_API_URL || 'http://localhost:3000';
    } else if (process.env.NODE_ENV === 'staging') {
        return process.env.STAGING_API_URL || 'http://localhost:3000';
    } else {
        return process.env.DEV_URL || 'http://localhost:3002';
    }
}

function jobPhaseForZipIngestStatus(
    status: 'uploading' | 'processing' | 'caching' | 'completed' | 'failed'
): string {
    switch (status) {
        case 'completed':
            return 'cdn_ingest_done';
        case 'failed':
            return 'failed';
        case 'caching':
            return 'cdn_caching';
        default:
            return 'cdn_processing';
    }
}

/**
 * Merges into the main API job document keyed by `uploadId` (same id as `X-Upload-Id` / level upload job).
 * Uses POST /v2/cdn/job-progress — must match {@link JOB_PROGRESS_INGEST_SECRET} on the main server.
 */
async function sendLevelUploadProgress(
    uploadId: string | undefined,
    status: 'uploading' | 'processing' | 'caching' | 'completed' | 'failed',
    progressPercent: number,
    currentStep?: string,
    error?: string,
    opts?: { cdnFileId?: string }
): Promise<void> {
    if (!uploadId) {
        return;
    }

    const secret = process.env.JOB_PROGRESS_INGEST_SECRET;
    if (!secret) {
        return;
    }

    const mainServerUrl = getMainServerUrl();
    const phase = jobPhaseForZipIngestStatus(status);
    const payload: Record<string, unknown> = {
        jobId: uploadId,
        kind: 'level_upload',
        phase,
        percent: status === 'failed' ? null : progressPercent,
        message: currentStep ?? (status === 'completed' ? 'CDN ingest complete' : undefined),
        error: status === 'failed' ? (error && error.length > 0 ? error : 'Upload failed') : null,
        meta:
            status === 'completed' && opts?.cdnFileId
                ? { cdnFileId: opts.cdnFileId, stage: 'cdn_ingest' }
                : { stage: 'cdn_ingest', ingestStatus: status }
    };

    try {
        await axios.post(`${mainServerUrl}/v2/cdn/job-progress`, payload, {
            headers: { 'X-Job-Ingest-Key': secret },
            timeout: 5000
        });
    } catch (err) {
        logger.debug('Failed to send level upload progress update', {
            uploadId,
            error: err instanceof Error ? err.message : String(err)
        });
    }
}

/**
 * Heavy zip work after HTTP 202 — must not block the POST response (main API polls job progress).
 */
async function runLevelZipIngestInBackground(args: {
    filePath: string;
    fileId: string;
    originalname: string;
    uploadId: string | undefined;
}): Promise<void> {
    const { filePath, fileId, originalname, uploadId } = args;
    try {
        await sendLevelUploadProgress(uploadId, 'uploading', 0, 'Processing zip on CDN');

        const onProgress = async (
            status: 'uploading' | 'processing' | 'caching' | 'completed' | 'failed',
            progressPercent: number,
            currentStep?: string
        ) => {
            await sendLevelUploadProgress(uploadId, status, progressPercent, currentStep);
        };

        logger.debug('Starting async zip file processing', { fileId });
        await processZipFile(filePath, fileId, originalname, onProgress);
        logger.debug('Successfully processed zip file (async)', { fileId });

        logger.debug('Cleaning up original zip file', { filePath });
        cdnLocalTemp.cleanupFiles(filePath);

        await sendLevelUploadProgress(uploadId, 'completed', 100, 'Upload completed', undefined, {
            cdnFileId: fileId,
        });
        logger.debug('Zip ingest completed (async)', { fileId });
    } catch (error) {
        logger.error('Error during async zip ingest:', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            fileId,
            filePath,
        });
        await sendLevelUploadProgress(
            uploadId,
            'failed',
            0,
            'Upload failed',
            error instanceof Error ? error.message : String(error)
        );
        cdnLocalTemp.cleanupFiles(filePath);
    }
}

// Level zip upload endpoint
router.post('/', (req: Request, res: Response) => {
    logger.debug('Received zip upload request');

    cdnLocalTemp.upload(req, res, (err) => {
        if (err) {
            logger.error('Multer error during zip upload:', {
                error: err.message,
                code: err.code,
                field: err.field,
                stack: err.stack
            });
            res.status(400).json({ error: err.message });
            return;
        }

        if (!req.file) {
            logger.warn('Zip upload attempt with no file');
            res.status(400).json({ error: 'No file uploaded' });
            return;
        }

        logger.debug('Uploaded zip staged (async ingest):', {
            filename: req.file.filename,
            size: req.file.size,
            mimetype: req.file.mimetype,
            path: req.file.path
        });

        const uploadId = req.headers['x-upload-id'] as string | undefined;
        const fileId = crypto.randomUUID();
        logger.debug('Generated UUID for database entry:', { fileId });

        const response = {
            success: true,
            fileId,
            url: `${CDN_CONFIG.baseUrl}/${fileId}`,
            message: 'ZIP accepted; processing continues on the CDN',
        };

        res.status(202).json(response);
        logger.debug('Zip upload acknowledged (202); starting background processing:', response);

        void runLevelZipIngestInBackground({
            filePath: req.file.path,
            fileId,
            originalname: req.file.originalname,
            uploadId,
        }).catch((e) => {
            logger.error('Unhandled error in async zip ingest runner:', e);
        });
        return;
    });
});

export default router;
