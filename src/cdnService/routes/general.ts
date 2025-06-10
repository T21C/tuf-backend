import { Router, Request, Response } from "express";
import { logger } from "../../services/LoggerService.js";
import CdnFile from "../../models/cdn/CdnFile.js";
import { CDN_CONFIG, MIME_TYPES } from "../config.js";
import FileAccessLog from "../../models/cdn/FileAccessLog.js";
import fs from "fs";
import path from "path";
import { storageManager } from "../services/storageManager.js";
const router = Router();

// Helper function to safely set headers with proper encoding
function setSafeHeader(res: Response, name: string, value: string | number | object): void {
    try {
        if (typeof value === 'object') {
            // For JSON objects, stringify and encode
            const encodedValue = encodeURIComponent(JSON.stringify(value));
            res.setHeader(name, `UTF-8''${encodedValue}`);
        } else {
            // For strings and numbers, encode directly
            const encodedValue = encodeURIComponent(String(value));
            res.setHeader(name, `UTF-8''${encodedValue}`);
        }
    } catch (error) {
        logger.error('Error setting header:', {
            header: name,
            error: error instanceof Error ? error.message : String(error)
        });
    }
}

async function handleZipRequest(req: Request, res: Response, file: CdnFile) {
        // For level zips, get the original zip from metadata
        const fileId = file.id;
        const metadata = file.metadata as {
            originalZip?: {
                name: string;
                path: string;
                size: number;
            };
            allLevelFiles?: Array<{
                name: string;
                path: string;
                size: number;
                hasYouTubeStream?: boolean;
                songFilename?: string;
            }>;
            songFiles?: Record<string, {
                name: string;
                path: string;
                size: number;
                type: string;
            }>;
            targetLevel?: string | null;
            pathConfirmed?: boolean;
        };

        if (!metadata.originalZip) {
            return res.status(404).json({ error: 'Original zip not found in metadata' });
        }

        const { originalZip } = metadata;
        
        // Check if file exists
        try {
            await fs.promises.access(originalZip.path, fs.constants.F_OK);
        } catch (error) {
            logger.error('Zip file not found on disk:', {
                fileId,
                path: originalZip.path,
                error: error instanceof Error ? error.message : String(error)
            });
            return res.status(404).json({ error: 'Zip file not found' });
        }

        // Get file stats
        const stats = await fs.promises.stat(originalZip.path);

        logger.debug('Setting headers for zip file:', {
            fileId,
            path: originalZip.path,
            baseName: originalZip.name
        });

        // Set basic headers
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Length', stats.size);
        
        // Set encoded filename in Content-Disposition
        const encodedFilename = encodeURIComponent(originalZip.name);
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedFilename}`);
        
        // Set encoded metadata headers
        setSafeHeader(res, 'X-Level-FileId', fileId);
        setSafeHeader(res, 'X-Level-Name', originalZip.name);
        setSafeHeader(res, 'X-Level-Size', originalZip.size);
        setSafeHeader(res, 'X-Level-Files', {
            levelFiles: metadata.allLevelFiles,
            songFiles: metadata.songFiles
        });
        setSafeHeader(res, 'X-Level-Target', {
            targetLevel: metadata.targetLevel,
            pathConfirmed: metadata.pathConfirmed
        });

        
        file.increment('accessCount');
        // Stream the file
        const fileStream = fs.createReadStream(originalZip.path);
        fileStream.pipe(res);

        // Handle errors during streaming
        fileStream.on('error', (error) => {
            logger.error('Error streaming zip file:', {
                fileId,
                path: originalZip.path,
                error: error instanceof Error ? error.message : String(error)
            });
            if (!res.headersSent) {
                res.status(500).json({ error: 'Error streaming file' });
            }
        });
        return;
    }


router.get('/:fileId', async (req: Request, res: Response) => {
    try {
        const { fileId } = req.params;
        const file = await CdnFile.findByPk(fileId);
        if (!file) {
            return res.status(404).json({ error: 'File not found' });
        }

        let filePath = file.filePath;

        if (file.type === 'LEVELZIP') {
            return handleZipRequest(req, res, file);
        }
        
        if (file.type === 'PROFILE') {
            filePath = path.join(file.filePath, 'original.png');
        }
        await FileAccessLog.create({
            fileId: fileId,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
            userAgent: req.get('user-agent') || null
        });

        await file.increment('accessCount');

        // Check if file exists
        try {
            await fs.promises.access(filePath, fs.constants.F_OK);
        } catch (error) {
            logger.error('File not found on disk:', {
                fileId,
                path: file.filePath,
                error: error instanceof Error ? error.message : String(error)
            });
            return res.status(404).json({ error: 'File not found' });
        }

        // Get file stats
        const stats = await fs.promises.stat(filePath);
        
        // Set headers
        res.setHeader('Content-Type', MIME_TYPES[file.type]);
        res.setHeader('Content-Length', stats.size);
        res.setHeader('Cache-Control', CDN_CONFIG.cacheControl);

        // Create read stream with error handling
        const fileStream = fs.createReadStream(filePath);
        
        // Handle stream errors
        fileStream.on('error', (error) => {
            logger.error('Error streaming file:', {
                fileId,
                path: filePath,
                error: error instanceof Error ? error.message : String(error)
            });
            if (!res.headersSent) {
                res.status(500).json({ error: 'Error streaming file' });
            }
        });

        // Handle client disconnect
        req.on('close', () => {
            fileStream.destroy();
        });

        // Pipe the file to response
        fileStream.pipe(res);
    } catch (error) {
        logger.error('File delivery error:', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
        });
        if (!res.headersSent) {
            res.status(500).json({ error: 'File delivery failed' });
        }
    }
    return;
});

router.get('/:fileId/metadata', async (req: Request, res: Response) => {
    try {
        const { fileId } = req.params;
        logger.debug(`Fetching metadata for file: ${fileId}`);
        const file = await CdnFile.findByPk(fileId);

        if (!file) {
            return res.status(404).json({ error: 'File not found' });
        }
        res.json({ metadata: file.metadata });
    } catch (error) {
        logger.error('File metadata retrieval error:', error);
        res.status(500).json({ error: 'File metadata retrieval failed' });
    }
    return;
});

// Delete file endpoint
router.delete('/:fileId', async (req: Request, res: Response) => {
    try {
        const { fileId } = req.params;
        const file = await CdnFile.findByPk(fileId);

        if (!file) {
            return res.status(404).json({ error: 'File not found' });
        }

        storageManager.cleanupFiles(file.filePath);
        
        // Delete the database entry
        await file.destroy();

        res.json({ success: true });
    } catch (error) {
        logger.error('File deletion error:', error);
        res.status(500).json({ error: 'File deletion failed' });
    }
    return;
});

export default router;