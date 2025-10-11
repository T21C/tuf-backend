import { Router, Request, Response } from "express";
import { logger } from "../../services/LoggerService.js";
import CdnFile from "../../models/cdn/CdnFile.js";
import { CDN_CONFIG, IMAGE_TYPES, MIME_TYPES } from "../config.js";
import FileAccessLog from "../../models/cdn/FileAccessLog.js";
import fs from "fs";
import path from "path";
import { storageManager } from "../services/storageManager.js";
import { hybridStorageManager, StorageType } from "../services/hybridStorageManager.js";
import { Op } from "sequelize";
import sequelize from "../../config/db.js";
import { Transaction } from "sequelize";
import { safeTransactionRollback } from "../../utils/Utility.js";
import { spacesStorage } from "../services/spacesStorage.js";

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

// Helper function to clean up old file access logs
async function cleanupOldAccessLogs(): Promise<void> {
    try {
        const oneWeekAgo = new Date();
        oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
        
        const deletedCount = await FileAccessLog.destroy({
            where: {
                createdAt: {
                    [Op.lt]: oneWeekAgo
                }
            }
        });
        
        if (deletedCount > 0) {
            logger.debug(`Cleaned up ${deletedCount} old file access logs older than 1 week`);
        }
    } catch (error) {
        logger.error('Error cleaning up old file access logs:', {
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
                originalFilename?: string;
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
            storageType?: StorageType;
        };

        if (!metadata.originalZip) {
            return res.status(404).json({ error: 'Original zip not found in metadata' });
        }

        const { originalZip } = metadata;
        
        // Check if file exists and get file stats
        let stats: fs.Stats;
        let fileStream: fs.ReadStream | NodeJS.ReadableStream;
        
        let fileCheck: { exists: boolean; storageType: StorageType; actualPath: string };
        
        try {
            // Use fallback logic to find the file
            fileCheck = await hybridStorageManager.fileExistsWithFallback(
                originalZip.path, 
                metadata.storageType
            );
            
            if (!fileCheck.exists) {
                logger.error('Zip file not found in any storage:', {
                    fileId,
                    path: originalZip.path,
                    preferredStorageType: metadata.storageType,
                    checkedStorageType: fileCheck.storageType
                });
                return res.status(404).json({ error: 'Zip file not found' });
            }
            
            logger.debug('File found using fallback logic:', {
                fileId,
                path: originalZip.path,
                foundInStorage: fileCheck.storageType,
                preferredStorage: metadata.storageType
            });
            
            if (fileCheck.storageType === StorageType.SPACES) {
                
                // Generate presigned URL for direct download (expires in 1 hour)
                const presignedUrl = await spacesStorage.getPresignedUrl(originalZip.path, 3600);
                
                logger.debug('Redirecting to Spaces presigned URL:', {
                    fileId,
                    path: originalZip.path,
                    url: presignedUrl
                });
                
                // Redirect to the presigned URL
                res.redirect(302, presignedUrl);
                return;
            } else {
                // For local storage, use the actual path found
                stats = await fs.promises.stat(fileCheck.actualPath);
                fileStream = fs.createReadStream(fileCheck.actualPath);
            }
        } catch (error) {
            logger.error('Zip file access error:', {
                fileId,
                path: originalZip.path,
                preferredStorageType: metadata.storageType,
                error: error instanceof Error ? error.message : String(error)
            });
            return res.status(404).json({ error: 'Zip file not found' });
        }

        // Only continue with local file streaming (Spaces files are redirected above)
        if (fileCheck.storageType === StorageType.LOCAL) {
            logger.debug('Setting headers for local zip file:', {
                fileId,
                path: originalZip.path,
                baseName: originalZip.name
            });

            // Handle range requests for better streaming support
            const range = req.headers.range;
            let start = 0;
            let end = stats.size - 1;
            let statusCode = 200;
            
            if (range) {
                const ranges = range.replace(/bytes=/, '').split('-');
                start = parseInt(ranges[0], 10);
                end = ranges[1] ? parseInt(ranges[1], 10) : stats.size - 1;
                
                if (start >= stats.size) {
                    res.status(416).setHeader('Content-Range', `bytes */${stats.size}`);
                    return res.end();
                }
                
                statusCode = 206; // Partial Content
                fileStream = fs.createReadStream(fileCheck.actualPath, { start, end });
            }
            
            // Set basic headers
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Length', end - start + 1);
            
            if (statusCode === 206) {
                res.setHeader('Content-Range', `bytes ${start}-${end}/${stats.size}`);
                res.setHeader('Accept-Ranges', 'bytes');
            }
            
            // Set filename in Content-Disposition (decode only when sending to user)
            const displayFilename = metadata.originalZip?.originalFilename || originalZip.name;
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(displayFilename)}`);
            
            // Set encoded metadata headers
            setSafeHeader(res, 'X-Level-FileId', fileId);
            setSafeHeader(res, 'X-Level-Name', displayFilename);
            setSafeHeader(res, 'X-Level-Size', originalZip.size);
            setSafeHeader(res, 'X-Level-Files', {
                levelFiles: metadata.allLevelFiles,
                songFiles: metadata.songFiles
            });
            setSafeHeader(res, 'X-Level-Target', {
                targetLevel: metadata.targetLevel,
                pathConfirmed: metadata.pathConfirmed
            });

            // Clean up old access logs before incrementing access count
            await cleanupOldAccessLogs();
            
            file.increment('accessCount');
            
            // Set status code for range requests
            res.status(statusCode);
            
            // Stream the file
            fileStream.pipe(res);

            // Handle errors during streaming
            (fileStream as any).on('error', (error: any) => {
                logger.error('Error streaming zip file:', {
                    fileId,
                    path: originalZip.path,
                    storageType: metadata.storageType || StorageType.LOCAL,
                    error: error instanceof Error ? error.message : String(error)
                });
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Error streaming file' });
                }
            });
        }
        return;
    }


// HEAD endpoint for checking file existence
router.head('/:fileId', async (req: Request, res: Response) => {
    try {
        const { fileId } = req.params;
        
        const file = await CdnFile.findByPk(fileId);
        if (!file) {
            return res.status(404).end();
        }

        // For LEVELZIP files, check if the file exists in storage using fallback logic
        if (file.type === 'LEVELZIP') {
            const metadata = file.metadata as any;
            const originalZip = metadata?.originalZip;
            
            if (originalZip?.path) {
                const fileCheck = await hybridStorageManager.fileExistsWithFallback(
                    originalZip.path,
                    originalZip.storageType
                );
                
                if (!fileCheck.exists) {
                    return res.status(404).end();
                }
            }
        } else {
            // For other file types, check if file exists on disk
            try {
                await fs.promises.access(file.filePath, fs.constants.F_OK);
            } catch (error) {
                return res.status(404).end();
            }
        }

        // File exists, return 200 with no body
        return res.status(200).end();
    } catch (error) {
        logger.error('HEAD request error:', {
            error: error instanceof Error ? error.message : String(error),
            fileId: req.params.fileId
        });
        return res.status(500).end();
    }
});

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
        
        // Handle image types - redirect to proper image endpoint or serve original
        if (IMAGE_TYPES[file.type as keyof typeof IMAGE_TYPES]) {
            filePath = path.join(file.filePath, 'original.png');
        }
        
        // Clean up old access logs before creating new ones
        await cleanupOldAccessLogs();
        
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
        res.setHeader('Content-Type', MIME_TYPES[file.type as keyof typeof MIME_TYPES]);
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
    let transaction: Transaction | undefined;
    
    try {
        const { fileId } = req.params;
        
        // Start transaction
        transaction = await sequelize.transaction();
        
        const file = await CdnFile.findByPk(fileId, { transaction });

        if (!file) {
            await safeTransactionRollback(transaction);
            return res.status(404).json({ error: 'File not found' });
        }

        // Store file information before deletion for cleanup
        const filePath = file.filePath;
        const fileType = file.type;
        const metadata = file.metadata as any;
        
        // Delete the database entry first within transaction
        await file.destroy({ transaction });
        
        // Commit the transaction
        await transaction.commit();
        
        // Clean up files using hybrid storage manager after successful database deletion
        try {
            if (fileType === 'LEVELZIP' && metadata) {
                // For level zip files, delete all associated files (extracted levels, songs, etc.)
                logger.debug('Deleting level zip and all associated files', {
                    fileId,
                    fileType,
                    hasMetadata: !!metadata
                });
                
                await hybridStorageManager.deleteLevelZipFiles(fileId, metadata);
                
                logger.debug('Level zip and associated files deleted successfully:', {
                    fileId,
                    fileType,
                    timestamp: new Date().toISOString()
                });
            } else {
                // For other file types, determine storage type and delete appropriately
                const storageType = metadata?.storageType || StorageType.LOCAL;
                
                if (IMAGE_TYPES[fileType as keyof typeof IMAGE_TYPES]) {
                    // Use specialized cleanup for image directories (legacy local storage)
                    if (storageType === StorageType.LOCAL) {
                        const cleanupSuccess = storageManager.cleanupImageDirectory(filePath, fileId, fileType);
                        if (cleanupSuccess) {
                            logger.debug('Image file deleted successfully:', {
                                fileId,
                                filePath,
                                type: fileType,
                                storageType,
                                timestamp: new Date().toISOString()
                            });
                        } else {
                            logger.error('Failed to cleanup image directory, but database entry was removed:', {
                                fileId,
                                filePath,
                                type: fileType,
                                storageType,
                                timestamp: new Date().toISOString()
                            });
                        }
                    } else {
                        // Use hybrid storage manager for cloud-stored images
                        await hybridStorageManager.deleteFile(filePath, storageType);
                        logger.debug('Image file deleted from hybrid storage successfully:', {
                            fileId,
                            filePath,
                            type: fileType,
                            storageType,
                            timestamp: new Date().toISOString()
                        });
                    }
                } else {
                    // Use hybrid storage manager for other file types
                    await hybridStorageManager.deleteFile(filePath, storageType);
                    logger.debug('File deleted from hybrid storage successfully:', {
                        fileId,
                        filePath,
                        type: fileType,
                        storageType,
                        timestamp: new Date().toISOString()
                    });
                }
            }
        } catch (cleanupError) {
            logger.error('Failed to clean up files from storage:', {
                error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                fileId,
                filePath,
                type: fileType,
                timestamp: new Date().toISOString()
            });
            // Don't fail the request if file cleanup fails - database is already updated
        }

        res.json({ success: true });
    } catch (error) {
        // Rollback transaction if it exists
        if (transaction) {
            try {
                await safeTransactionRollback(transaction);
            } catch (rollbackError) {
                logger.warn('Transaction rollback failed:', rollbackError);
            }
        }
        
        logger.error('File deletion error:', {
            error: error instanceof Error ? error.message : String(error),
            fileId: req.params.fileId,
            timestamp: new Date().toISOString()
        });
        res.status(500).json({ error: 'File deletion failed' });
    }
    return;
});

export default router;