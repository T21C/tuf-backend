import { Router, Request, Response } from 'express';
import { logger } from '@/server/services/LoggerService.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import { CDN_CONFIG, IMAGE_TYPES, MIME_TYPES } from '@/externalServices/cdnService/config.js';
//import FileAccessLog from '@/models/cdn/FileAccessLog.js';
import fs from 'fs';
import path from 'path';
import { spacesStorage } from '@/externalServices/cdnService/services/spacesStorage.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
import { Transaction } from 'sequelize';

const cdnSequelize = getSequelizeForModelGroup('cdn');
import { safeTransactionRollback } from '@/misc/utils/Utility.js';

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

// Note: Cleanup removed - logging tables are now in separate database
// and should be managed separately to prevent snapshot backup size issues
// async function cleanupOldAccessLogs(): Promise<void> {
//     // Cleanup removed - logs are now in separate database
// }

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
        };

        if (!metadata.originalZip) {
            return res.status(404).json({ error: 'Original zip not found in metadata' });
        }

        const { originalZip } = metadata;

        // Check if file exists and get file stats
        let fileExists: boolean;

        try {
            // Use fallback logic to find the file
            fileExists = await spacesStorage.fileExists(
                originalZip.path,
            );

            if (!fileExists) {
                logger.error('Zip file not found in any storage:', {
                    fileId,
                    path: originalZip.path,
                });
                return res.status(404).json({ error: 'Zip file not found' });
            }

            // Generate presigned URL for direct download (expires in 1 hour)
            const presignedUrl = await spacesStorage.getPresignedUrl(originalZip.path);

            logger.debug('Redirecting to Spaces presigned URL:', {
                fileId,
                path: originalZip.path,
                url: presignedUrl
            });

            // Cache the redirect itself aggressively since the target URL is immutable.
            res.setHeader('Cache-Control', CDN_CONFIG.cacheControl);
            res.redirect(301, presignedUrl);
            return;
        } catch (error) {
            logger.error('Zip file access error:', {
                fileId,
                path: originalZip.path,
                error: error instanceof Error ? error.message : String(error)
            });
            return res.status(404).json({ error: 'Zip file not found' });
        }
    }


// HEAD endpoint for checking file existence
router.head('/:fileId', async (req: Request, res: Response) => {
    try {
        const { fileId } = req.params;

        const file = await CdnFile.findByPk(fileId);
        if (!file) {
            return res.status(404).end();
        }

        const metadata = (file.metadata || {}) as any;

        // For LEVELZIP files, check if the file exists in storage using fallback logic
        if (file.type === 'LEVELZIP') {
            const originalZip = metadata?.originalZip;

            if (originalZip?.path) {
                const fileExists = await spacesStorage.fileExists(
                    originalZip.path,
                );

                if (!fileExists) {
                    return res.status(404).end();
                }
            }
        } else if (IMAGE_TYPES[file.type as keyof typeof IMAGE_TYPES]) {
            const originalVariant = metadata?.variants?.original;

            if (originalVariant?.path) {
                const imageExists = await spacesStorage.fileExists(originalVariant.path);
                if (!imageExists) {
                    return res.status(404).end();
                }
            } else {
                // Backward-compatible image existence check for records without variants metadata.
                const imageTypeConfig = IMAGE_TYPES[file.type as keyof typeof IMAGE_TYPES];
                const canonicalKey = `images/${imageTypeConfig.name}/${fileId}/original.png`;
                const canonicalCheck = await spacesStorage.fileExists(
                    canonicalKey,
                );
                if (!canonicalCheck) {
                    return res.status(404).end();
                }
            }
        } else {
            // For other file types, check via hybrid storage (Spaces-first with local fallback).
            const fileExists = await spacesStorage.fileExists(
                file.filePath,
            );
            if (!fileExists) {
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

        if (file.type === 'LEVELZIP') {
            return handleZipRequest(req, res, file);
        }

        // Handle image types - redirect to proper image endpoint or serve original
        if (IMAGE_TYPES[file.type as keyof typeof IMAGE_TYPES]) {
            const imageMetadata = (file.metadata || {}) as any;
            const originalVariant = imageMetadata?.variants?.original;
            if (originalVariant?.path) {
                const imageExists = await spacesStorage.fileExists(originalVariant.path);
                if (!imageExists) {
                    return res.status(404).json({ error: 'File not found' });
                }
                const url = await spacesStorage.getPresignedUrl(originalVariant.path);
                // Cache the redirect itself aggressively since the target URL is immutable.
                res.setHeader('Cache-Control', CDN_CONFIG.cacheControl);
                return res.redirect(301, url);
            }
        }

        await file.increment('accessCount');
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
        transaction = await cdnSequelize.transaction();

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

                await spacesStorage.deleteCdnLevelZipClustersByFileId(fileId);

                logger.debug('Level zip and associated files deleted successfully:', {
                    fileId,
                    fileType,
                    timestamp: new Date().toISOString()
                });
            } 
            else {
                if (IMAGE_TYPES[fileType as keyof typeof IMAGE_TYPES]) {
                    const imageTypeConfig = IMAGE_TYPES[fileType as keyof typeof IMAGE_TYPES];
                    const spacesImageFolderKey = imageTypeConfig
                        ? `images/${imageTypeConfig.name}/${fileId}`
                        : null;
                    if (spacesImageFolderKey) {
                        try {
                            const ok = await spacesStorage.deleteFolder(spacesImageFolderKey);
                            if (ok) {
                                logger.debug('Image Spaces UUID folder deleted', {
                                    fileId,
                                    key: spacesImageFolderKey
                                });
                            } else {
                                logger.warn('Image Spaces folder delete did not complete successfully', {
                                    fileId,
                                    key: spacesImageFolderKey
                                });
                            }
                        } catch (prefixCleanupError) {
                            logger.warn('Image Spaces folder cleanup failed', {
                                fileId,
                                key: spacesImageFolderKey,
                                error: prefixCleanupError instanceof Error
                                    ? prefixCleanupError.message
                                    : String(prefixCleanupError)
                            });
                        }
                    }

                    logger.debug('Image cleanup completed', {
                        fileId,
                        type: fileType,
                        spacesFolderKey: spacesImageFolderKey,
                        timestamp: new Date().toISOString()
                    });
                } else {
                    // Use hybrid storage manager for other file types
                    await spacesStorage.deleteFile(filePath);
                    logger.debug('File deleted from hybrid storage successfully:', {
                        fileId,
                        filePath,
                        type: fileType,
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
