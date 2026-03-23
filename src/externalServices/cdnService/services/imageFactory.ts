import fs from 'fs';
import path from 'path';
import { CDN_CONFIG, IMAGE_TYPES, ImageType } from '../config.js';
import { logger } from '@/server/services/LoggerService.js';
import { validateImage, getValidationOptionsForType, ImageValidationError } from './imageValidator.js';
import { processImage } from './imageProcessor.js';
import { cdnLocalTemp } from './cdnLocalTempManager.js';
import { spacesStorage } from './spacesStorage.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
import { Transaction } from 'sequelize';

const cdnSequelize = getSequelizeForModelGroup('cdn');
import { safeTransactionRollback } from '@/misc/utils/Utility.js';

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
        const imageConfig = IMAGE_TYPES[imageType];
        const fileId = path.parse(filePath).name;
        const imageDir = path.join(
            cdnLocalTemp.getLocalRoot(),
            'temp-image-processing',
            imageConfig.name,
            fileId
        );

        try {
            // Validate image
            const validationOptions = getValidationOptionsForType(imageType);
            await validateImage(filePath, imageType, validationOptions);


            // Create directory for this image's versions
            cdnLocalTemp.ensureDirUnderLocalRoot(imageDir);

            // Save original file
            const originalPath = path.join(imageDir, 'original.png');
            fs.copyFileSync(filePath, originalPath);
            cdnLocalTemp.cleanupFiles(filePath);

            // Process variants
            await processImage(originalPath, imageType, fileId, imageDir);

            const variantNames = Object.keys(imageConfig.sizes);
            const variantStorage: Record<string, {
                path: string;
                url?: string;
            }> = {};

            await Promise.all(
                variantNames.map(async (variantName) => {
                    const localVariantPath = path.join(imageDir, `${variantName}.png`);
                    const spacesKey = `images/${imageConfig.name}/${fileId}/${variantName}.png`;
                    const uploadResult = await spacesStorage.uploadFile(localVariantPath, spacesKey, 'image/png');
                    variantStorage[variantName] = {
                        path: spacesKey,
                        url: uploadResult.url,
                    };
                })
            );

            // Start transaction for database operations
            transaction = await cdnSequelize.transaction();

            // Create database entry with absolute path within transaction
            const originalVariant = variantStorage.original;
            await CdnFile.create({
                id: fileId,
                type: imageType,
                filePath: originalVariant?.path || imageDir,
                metadata: {
                    variants: variantStorage,
                }
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
        } finally {
            if (imageDir) {
                try {
                    cdnLocalTemp.cleanupFiles(imageDir);
                } catch (cleanupError) {
                    logger.error('Failed to clean up temp image processing directory:', {
                        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                        imageDir,
                        timestamp: new Date().toISOString()
                    });
                }
            }
        }
    }
}

export default ImageFactory.getInstance();
