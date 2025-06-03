import path from "path";
import { logger } from "../../services/LoggerService.js";
import { cleanupFiles, upload } from "../services/storage.js";
import CdnFile from "../../models/cdn/CdnFile.js";
import { CDN_CONFIG } from "../config.js";
import { processZipFile } from "../services/zipProcessor.js";
import { Request, Response, Router } from 'express';

const router = Router();
// File upload endpoint
router.post('/', (req: Request, res: Response) => {
    upload(req, res, async (err) => {
        if (err) {
            logger.error('Multer error:', err);
            return res.status(400).json({ error: err.message });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        try {
            const fileId = path.parse(req.file.filename).name;
            const file = await CdnFile.create({
                id: fileId,
                purpose: 'GENERAL', // Default purpose for general file uploads
                originalName: req.file.originalname,
                filePath: req.file.path,
                fileType: path.extname(req.file.originalname).toLowerCase(),
                fileSize: req.file.size,
                mimeType: req.file.mimetype
            });

            // Process zip files
            if (file.fileType === '.zip') {
                await processZipFile(file.filePath, file.id);
            }

            res.json({
                success: true,
                fileId: file.id,
                url: `${CDN_CONFIG.baseUrl}/cdn/${file.id}`
            });
        } catch (error) {
            logger.error('Upload error:', error);
            cleanupFiles(req.file.path);
            res.status(500).json({ error: 'File upload failed' });
        }
        return;
    });
    return;
});

export default router;
