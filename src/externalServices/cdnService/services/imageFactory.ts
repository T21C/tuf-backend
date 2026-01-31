import fs from 'fs';
import path from 'path';
import { CDN_CONFIG, IMAGE_TYPES, ImageType } from '../config.js';
import { logger } from '../../../server/services/LoggerService.js';
import { validateImage, getValidationOptionsForType, ImageValidationError } from './imageValidator.js';
import { processImage } from './imageProcessor.js';
import { storageManager } from './storageManager.js';
import CdnFile from '../../../models/cdn/CdnFile.js';
import { getSequelizeForModelGroup } from '../../../config/db.js';
import { Transaction } from 'sequelize';

const cdnSequelize = getSequelizeForModelGroup('cdn');
import { safeTransactionRollback } from '../../../misc/utils/Utility.js';


export interface ImageUploadResult {
    success: boolean;
    fileId: string;
    urls: Record<string, string>;
}

export class ImageProcessingError extends Error {
    constructor(
        message: string,
        public code: string,
        public details?: any
    ) {
        super(message);
        this.name = 'ImageProcessingError';
    }
}

export class ImageFactory {
    private static instance: ImageFactory;

    private constructor() {}

    public static getInstance(): ImageFactory {
        if (!ImageFactory.instance) {
            ImageFactory.instance = new ImageFactory();
        }
        return ImageFactory.instance;
    }

    async processImageUpload(
        filePath: string,
        imageType: ImageType
    ): Promise<ImageUploadResult> {
        let transaction: Transaction | undefined;
        let imageDir: string | null = null;

        try {
            // Validate image
            const validationOptions = getValidationOptionsForType(imageType);
            await validateImage(filePath, imageType, validationOptions);

            const fileId = path.parse(filePath).name;
            const imageConfig = IMAGE_TYPES[imageType];
            imageDir = path.join(CDN_CONFIG.user_root, 'images', imageConfig.name, fileId);

            // Create directory for this image's versions
            fs.mkdirSync(imageDir, { recursive: true });

            // Save original file
            const originalPath = path.join(imageDir, 'original.png');
            fs.copyFileSync(filePath, originalPath);
            storageManager.cleanupFiles(filePath);

            // Process variants
            await processImage(originalPath, imageType, fileId);

            // Start transaction for database operations
            transaction = await cdnSequelize.transaction();

            // Create database entry with absolute path within transaction
            await CdnFile.create({
                id: fileId,
                type: imageType,
                filePath: imageDir, // Store absolute path
            }, { transaction });

            // Commit the transaction
            await transaction.commit();

            logger.debug('Image uploaded successfully:', {
                fileId,
                imageType,
                imageDir,
                timestamp: new Date().toISOString()
            });

            // Generate URLs
            const urls = {
                original: `${CDN_CONFIG.baseUrl}/images/${imageType}/${fileId}/original`,
                large: `${CDN_CONFIG.baseUrl}/images/${imageType}/${fileId}/large`,
                medium: `${CDN_CONFIG.baseUrl}/images/${imageType}/${fileId}/medium`,
                small: `${CDN_CONFIG.baseUrl}/images/${imageType}/${fileId}/small`,
                ...(('thumbnail' in IMAGE_TYPES[imageType].sizes) ? {
                    thumbnail: `${CDN_CONFIG.baseUrl}/images/${imageType}/${fileId}/thumbnail`
                } : {})
            };

            return {
                success: true,
                fileId,
                urls,
            };
        } catch (error) {
            // Rollback transaction if it exists
            if (transaction) {
                try {
                    await safeTransactionRollback(transaction);
                } catch (rollbackError) {
                    logger.warn('Transaction rollback failed:', rollbackError);
                }
            }

            // Clean up created files if database operation failed
            if (imageDir && fs.existsSync(imageDir)) {
                try {
                    storageManager.cleanupFiles(imageDir);
                    logger.debug('Cleaned up image directory after failed upload:', {
                        imageDir,
                        timestamp: new Date().toISOString()
                    });
                } catch (cleanupError) {
                    logger.error('Failed to clean up image directory after failed upload:', {
                        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                        imageDir,
                        timestamp: new Date().toISOString()
                    });
                }
            }

            logger.error('Image processing error:', {
                error: error instanceof Error ? error.message : String(error),
                filePath,
                imageType,
                timestamp: new Date().toISOString()
            });

            if (error instanceof ImageValidationError) {
                throw new ImageProcessingError(
                    'Image validation failed',
                    'VALIDATION_ERROR',
                    {
                        errors: error.errors,
                        warnings: error.warnings,
                        metadata: error.metadata
                    }
                );
            }

            throw new ImageProcessingError(
                'Failed to process image',
                'PROCESSING_ERROR',
                { originalError: error instanceof Error ? error.message : String(error) }
            );
        }
    }
}

export default ImageFactory.getInstance();
