import { Router, Request, Response } from "express";
import { logger } from "../../services/LoggerService.js";
import { cleanupFiles } from "../services/storage.js";
import CdnFile from "../../models/cdn/CdnFile.js";
import { CDN_CONFIG } from "../config.js";
import FileAccessLog from "../../models/cdn/FileAccessLog.js";
import fs from "fs";
import path from "path";
const router = Router();

router.get('/:fileId', async (req: Request, res: Response) => {
    try {
        const { fileId } = req.params;
        const file = await CdnFile.findByPk(fileId);

        if (!file) {
            return res.status(404).json({ error: 'File not found' });
        }

        if (file.isDirectory) {
            return res.status(400).json({ error: 'Cannot download directory' });
        }
        
        await FileAccessLog.create({
            fileId: fileId,
            ipAddress: req.ip,
            userAgent: req.get('user-agent') || null
        });

        await file.increment('accessCount');

        res.setHeader('Content-Type', file.mimeType);
        res.setHeader('Cache-Control', CDN_CONFIG.cacheControl);
        fs.createReadStream(file.filePath).pipe(res);
    } catch (error) {
        logger.error('File delivery error:', error);
        res.status(500).json({ error: 'File delivery failed' });
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

        // Get the full path relative to CDN root
        const fullPath = path.join(CDN_CONFIG.root, file.filePath);
        
        if (file.isDirectory) {
            // If it's a directory, recursively delete all contents
            if (fs.existsSync(fullPath) && fs.lstatSync(fullPath).isDirectory() && path.basename(fullPath) === fileId) {
                fs.rmSync(fullPath, { recursive: true });
            }
        } else {
            // For single files, just delete the file
            cleanupFiles(file.filePath);
        }
        
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