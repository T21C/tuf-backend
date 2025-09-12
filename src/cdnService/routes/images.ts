import { logger } from "../../services/LoggerService.js";
import imageFactory, { ImageProcessingError } from "../services/imageFactory.js";
import { CDN_CONFIG, IMAGE_TYPES, ImageType, ImageSize, MIME_TYPES } from "../config.js";
import { Request, Response, Router } from 'express';
import CdnFile from "../../models/cdn/CdnFile.js";
import fs from 'fs';
import path from 'path';
import FileAccessLog from "../../models/cdn/FileAccessLog.js";
import { storageManager } from "../services/storageManager.js";

const router = Router();

// Get image endpoint
router.get('/:type/:fileId/:size', async (req: Request, res: Response) => {
    try {
        const { type, fileId, size } = req.params;
        const imageType = type.toUpperCase() as ImageType;
        const imageSize = size as ImageSize;

        if (!IMAGE_TYPES[imageType] || !(imageSize in IMAGE_TYPES[imageType].sizes)) {
            return res.status(400).json({ error: 'Invalid image type or size' });
        }

        // Find the original file by ID and type
        const file = await CdnFile.findOne({
            where: {
                id: fileId,
                type: imageType
            }
        });

        if (!file) {
            return res.status(404).json({ error: 'Image not found' });
        }

        // Use the absolute path directly
        const fsPath = path.join(file.filePath, `${imageSize}.png`);

        if (!fs.existsSync(fsPath)) {
            logger.error(`File not found on disk: ${fsPath}`);
            return res.status(404).json({ error: 'Image file not found' });
        }

        // Log access
        await FileAccessLog.create({
            fileId: file.id,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
            userAgent: req.get('user-agent') || null
        });

        await file.increment('accessCount');

        res.setHeader('Content-Type', MIME_TYPES[file.type as ImageType]);
        res.setHeader('Cache-Control', CDN_CONFIG.cacheControl);
        fs.createReadStream(fsPath).pipe(res);
    } catch (error) {
        logger.error('Image delivery error:', error);
        res.status(500).json({ error: 'Image delivery failed' });
    }
    return;
});

// Upload image endpoint
router.post('/:type', (req: Request, res: Response) => {
    const imageType = req.params.type.toUpperCase() as ImageType;
    const typeHeader = req.headers['x-file-type'] as ImageType;
    
    if (!IMAGE_TYPES[imageType]) {
        return res.status(400).json({ 
            error: 'Invalid image type',
            code: 'INVALID_TYPE'
        });
    }

    // Validate that type header matches the URL parameter
    if (typeHeader && typeHeader !== imageType) {
        return res.status(400).json({ 
            error: 'Type mismatch',
            code: 'TYPE_MISMATCH',
            details: 'The X-File-Type header does not match the image type in the URL'
        });
    }

    storageManager.imageUpload(req, res, async (err) => {
        if (err) {
            logger.error('Image upload error:', err);
            return res.status(400).json({ 
                error: err.message,
                code: 'UPLOAD_ERROR'
            });
        }

        if (!req.file) {
            return res.status(400).json({ 
                error: 'No image uploaded',
                code: 'NO_FILE'
            });
        }

        try {
            const result = await imageFactory.processImageUpload(
                req.file.path,
                imageType
            );

            res.json(result);
        } catch (error) {
            logger.error('Image processing error:', error);
            storageManager.cleanupFiles(req.file.path);
            
            if (error instanceof ImageProcessingError) {
                return res.status(400).json({
                    error: error.message,
                    code: error.code,
                    details: error.details
                });
            }
            
            res.status(500).json({ 
                error: 'Image processing failed',
                code: 'PROCESSING_ERROR',
                details: error instanceof Error ? error.message : String(error)
            });
        }
        return;
    });
    return;
});

export default router;
