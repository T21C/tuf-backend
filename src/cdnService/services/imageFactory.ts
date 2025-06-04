import fs from 'fs';
import path from 'path';
import { CDN_CONFIG, IMAGE_TYPES, ImageType } from '../config.js';
import { logger } from '../../services/LoggerService.js';
import { validateImage, getValidationOptionsForType, ImageValidationError } from './imageValidator.js';
import { processImage } from './imageProcessor.js';
import { storageManager } from './storageManager.js';
import CdnFile from '../../models/cdn/CdnFile.js';


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
        try {
            // Validate image
            const validationOptions = getValidationOptionsForType(imageType);
            const validationResult = await validateImage(filePath, imageType, validationOptions);
            
            const fileId = path.parse(filePath).name;
            const imageConfig = IMAGE_TYPES[imageType];
            const imageDir = path.join(CDN_CONFIG.user_root, 'images', imageConfig.name, fileId);
            
            // Create directory for this image's versions
            fs.mkdirSync(imageDir, { recursive: true });
            
            // Save original file
            const originalPath = path.join(imageDir, 'original.png');
            fs.copyFileSync(filePath, originalPath);
            storageManager.cleanupFiles(filePath);

            // Process variants
            const processedFiles = await processImage(originalPath, imageType, fileId);
            
            // Create database entry with absolute path
            await CdnFile.create({
                id: fileId,
                type: imageType,
                filePath: imageDir, // Store absolute path
                fileSize: fs.statSync(originalPath).size,
                isDirectory: true,
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
            logger.error('Image processing error:', error);
            storageManager.cleanupFiles(filePath);
            
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