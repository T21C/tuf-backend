import { logger } from '@/server/services/core/LoggerService.js';
import { CDN_CONFIG } from '@/externalServices/cdnService/config.js';
import { processZipFile, zipIngestFailureProgressWasSent } from '@/externalServices/cdnService/services/zipProcessor.js';
import { Request, Response, Router } from 'express';
import crypto from 'crypto';
import { cdnLocalTemp } from '@/externalServices/cdnService/infra/workspaces/cdnLocalTempManager.js';
import { CDN_JOB_KIND, emitCdnJobProgress, type CdnPipelineStatus } from '@/externalServices/cdnService/jobs/jobProgressIngest.js';
import { classifyZipIngestError } from '@/externalServices/cdnService/jobs/zipIngestErrorClassification.js';

const router = Router();

/**
 * Heavy zip work after HTTP 202 — must not block the POST response (main API polls job progress).
 */
async function runLevelZipIngestInBackground(args: {
    filePath: string;
    fileId: string;
    originalname: string;
    uploadId: string | undefined;
}): Promise<void> {
    const {filePath, fileId, originalname, uploadId} = args;
    try {
        await emitCdnJobProgress({
            variant: 'pipeline',
            jobId: uploadId,
            kind: CDN_JOB_KIND.LEVEL_UPLOAD,
            status: 'uploading',
            percent: 0,
            message: 'Processing zip on CDN',
        });

        const onProgress = async (
            status: CdnPipelineStatus,
            progressPercent: number,
            currentStep?: string,
            failureUserMessage?: string
        ) => {
            await emitCdnJobProgress({
                variant: 'pipeline',
                jobId: uploadId,
                kind: CDN_JOB_KIND.LEVEL_UPLOAD,
                status,
                percent: progressPercent,
                message: currentStep,
                error: status === 'failed' ? failureUserMessage : undefined,
            });
        };

        logger.debug('Starting async zip file processing', {fileId});
        await processZipFile(filePath, fileId, originalname, onProgress);
        logger.debug('Successfully processed zip file (async)', {fileId});

        logger.debug('Cleaning up original zip file', {filePath});
        cdnLocalTemp.cleanupFiles(filePath);

        await emitCdnJobProgress({
            variant: 'pipeline',
            jobId: uploadId,
            kind: CDN_JOB_KIND.LEVEL_UPLOAD,
            status: 'completed',
            percent: 100,
            message: 'Upload completed',
            completedAssetId: fileId,
        });
        logger.debug('Zip ingest completed (async)', {fileId});
    } catch (error) {
        const classified = classifyZipIngestError(error);
        const progressAlreadyHandled = zipIngestFailureProgressWasSent(error);

        if (!progressAlreadyHandled) {
            if (classified.serverLog === 'error') {
                logger.error('Error during async zip ingest:', {
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                    fileId,
                    filePath,
                });
            } else if (classified.serverLog === 'info') {
                logger.info('Zip ingest rejected:', {
                    message: classified.userMessage,
                    fileId,
                    filePath,
                });
            }

            await emitCdnJobProgress({
                variant: 'pipeline',
                jobId: uploadId,
                kind: CDN_JOB_KIND.LEVEL_UPLOAD,
                status: 'failed',
                percent: 0,
                message: 'Upload failed',
                error: classified.userMessage,
            });
        }

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
                stack: err.stack,
            });
            res.status(400).json({error: err.message});
            return;
        }

        if (!req.file) {
            logger.warn('Zip upload attempt with no file');
            res.status(400).json({error: 'No file uploaded'});
            return;
        }

        logger.debug('Uploaded zip staged (async ingest):', {
            filename: req.file.filename,
            size: req.file.size,
            mimetype: req.file.mimetype,
            path: req.file.path,
        });

        const uploadId = req.headers['x-upload-id'] as string | undefined;
        const fileId = crypto.randomUUID();
        logger.debug('Generated UUID for database entry:', {fileId});

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
