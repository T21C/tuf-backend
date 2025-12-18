import fs from 'fs';
import sharp from 'sharp';
import { IMAGE_TYPES, ImageType } from '../config.js';
import { logger } from '../../services/LoggerService.js';

export interface ImageValidationResult {
    isValid: boolean;
    errors: string[];
    warnings: string[];
    metadata: {
        width: number;
        height: number;
        format: string;
        size: number;
        hasAlpha: boolean;
        isAnimated: boolean;
        aspectRatio: number;
        colorSpace: string;
        dominantColor?: string;
    };
}

export interface ValidationOptions {
    minWidth?: number;
    maxWidth?: number;
    minHeight?: number;
    maxHeight?: number;
    maxSize?: number;
    allowedFormats?: string[];
    requireSquare?: boolean;
    maxAspectRatio?: number;
    minAspectRatio?: number;
}

const DEFAULT_OPTIONS: ValidationOptions = {
    minWidth: 100,
    maxWidth: 4096,
    minHeight: 100,
    maxHeight: 4096,
    maxSize: 10 * 1024 * 1024, // 10MB
    allowedFormats: ['jpeg', 'jpg', 'png', 'webp'],
    requireSquare: false,
    maxAspectRatio: 2,
    minAspectRatio: 0.5
};

const IMAGE_SIGNATURES = {
    // JPEG signatures
    jpeg: [
        'ffd8ffe0', // JPEG with JFIF
        'ffd8ffe1', // JPEG with EXIF
        'ffd8ffe2', // JPEG with ICC
        'ffd8ffe3', // JPEG with JFIF
        'ffd8ffe8', // JPEG with SPIFF
        'ffd8ffdb', // JPEG with DCT
        'ffd8ffed', // JPEG with Adobe
        'ffd8ffee'  // JPEG with Adobe
    ],
    // PNG signature
    png: [
        '89504e47'  // PNG
    ],
    // WebP signatures
    webp: [
        '52494646', // RIFF
        '57454250'  // WEBP
    ],
    // GIF signature
    gif: [
        '47494638'  // GIF87a/GIF89a
    ]
};

export class ImageValidationError extends Error {
    constructor(
        public errors: string[],
        public warnings: string[],
        public metadata: ImageValidationResult['metadata']
    ) {
        super(errors.join(', '));
        this.name = 'ImageValidationError';
    }
}

export async function validateImage(
    filePath: string,
    imageType: ImageType,
    customOptions?: Partial<ValidationOptions>
): Promise<ImageValidationResult> {
    const options = { ...DEFAULT_OPTIONS, ...customOptions };
    const result: ImageValidationResult = {
        isValid: true,
        errors: [],
        warnings: [],
        metadata: {
            width: 0,
            height: 0,
            format: '',
            size: 0,
            hasAlpha: false,
            isAnimated: false,
            aspectRatio: 0,
            colorSpace: ''
        }
    };

    try {
        // Check if file exists
        if (!fs.existsSync(filePath)) {
            result.isValid = false;
            result.errors.push('File does not exist');
        }

        // Check file size
        const stats = fs.statSync(filePath);
        result.metadata.size = stats.size;

        if (stats.size > options.maxSize!) {
            result.isValid = false;
            result.errors.push(`File size exceeds maximum allowed size of ${options.maxSize! / (1024 * 1024)}MB`);
        }

        // Get image metadata
        const metadata = await sharp(filePath).metadata();
        result.metadata.width = metadata.width || 0;
        result.metadata.height = metadata.height || 0;
        result.metadata.format = metadata.format || '';
        result.metadata.hasAlpha = metadata.hasAlpha || false;
        result.metadata.isAnimated = metadata.pages ? metadata.pages > 1 : false;
        result.metadata.colorSpace = metadata.space || '';
        result.metadata.aspectRatio = result.metadata.width / result.metadata.height;

        // Validate dimensions
        if (result.metadata.width < options.minWidth!) {
            result.isValid = false;
            result.errors.push(`Image width too small (minimum ${options.minWidth}px)`);
        }

        if (result.metadata.width > options.maxWidth!) {
            result.warnings.push(`Image width very large (maximum ${options.maxWidth}px)`);
        }

        if (result.metadata.height < options.minHeight!) {
            result.isValid = false;
            result.errors.push(`Image height too small (minimum ${options.minHeight}px)`);
        }

        if (result.metadata.height > options.maxHeight!) {
            result.warnings.push(`Image height very large (maximum ${options.maxHeight}px)`);
        }

        // Check aspect ratio
        if (options.requireSquare && result.metadata.width !== result.metadata.height) {
            result.isValid = false;
            result.errors.push('Image must be square');
        }

        if (result.metadata.aspectRatio > options.maxAspectRatio!) {
            result.warnings.push(`Image aspect ratio too wide (maximum ${options.maxAspectRatio})`);
        }

        if (result.metadata.aspectRatio < options.minAspectRatio!) {
            result.warnings.push(`Image aspect ratio too tall (minimum ${options.minAspectRatio})`);
        }

        // Check for animated images
        if (result.metadata.isAnimated) {
            result.warnings.push('Animated images are not recommended');
        }

        // Validate format
        if (!options.allowedFormats!.includes(result.metadata.format)) {
            result.isValid = false;
            result.errors.push(`Invalid image format. Allowed formats: ${options.allowedFormats!.join(', ')}`);
        }

        // Check for potential malicious content
        const buffer = await fs.promises.readFile(filePath);
        const header = buffer.slice(0, 8).toString('hex');

        // Check for valid image signatures
        const isValidSignature = Object.values(IMAGE_SIGNATURES).some(signatures =>
            signatures.some(sig => header.startsWith(sig))
        );

        if (!isValidSignature) {
            result.isValid = false;
            result.errors.push('Invalid image file signature. File may be corrupted or not a valid image.');
        }

        // Additional format-specific checks
        if (result.metadata.format === 'jpeg' && !IMAGE_SIGNATURES.jpeg.some(sig => header.startsWith(sig))) {
            result.warnings.push('JPEG file may be corrupted or modified');
        }

        if (result.metadata.format === 'png' && !IMAGE_SIGNATURES.png.some(sig => header.startsWith(sig))) {
            result.warnings.push('PNG file may be corrupted or modified');
        }

        if (result.metadata.format === 'webp' && !IMAGE_SIGNATURES.webp.some(sig => header.startsWith(sig))) {
            result.warnings.push('WebP file may be corrupted or modified');
        }

        // Try to get dominant color
        try {
            const { dominant } = await sharp(filePath)
                .stats();
            result.metadata.dominantColor = `#${dominant.r.toString(16).padStart(2, '0')}${dominant.g.toString(16).padStart(2, '0')}${dominant.b.toString(16).padStart(2, '0')}`;
        } catch (error) {
            logger.warn('Failed to get dominant color:', error);
        }

        // Check for transparency if not allowed
        if (result.metadata.hasAlpha && !['png', 'webp'].includes(result.metadata.format)) {
            result.warnings.push('Transparency is only supported in PNG and WebP formats');
        }

        if (!result.isValid) {
            throw new ImageValidationError(result.errors, result.warnings, result.metadata);
        }

        return result;
    } catch (error) {
        if (error instanceof ImageValidationError) {
            throw error;
        }
        throw new ImageValidationError(
            ['Failed to validate image: ' + (error instanceof Error ? error.message : String(error))],
            [],
            result.metadata
        );
    }
}

export function getValidationOptionsForType(imageType: ImageType): ValidationOptions {
    const typeConfig = IMAGE_TYPES[imageType];
    const sizes = typeConfig.sizes.original;

    // Very loose validation for level thumbnails
    if (imageType === 'LEVEL_THUMBNAIL') {
        return {
            minWidth: 50,  // Very small minimum width
            maxWidth: 4096, // Large maximum width
            minHeight: 50,  // Very small minimum height
            maxHeight: 4096, // Large maximum height
            maxSize: typeConfig.maxSize,
            allowedFormats: [...typeConfig.formats],
            requireSquare: false, // Allow any aspect ratio
            maxAspectRatio: 5, // Allow very wide images
            minAspectRatio: 0.2 // Allow very tall images
        };
    }

    // More lenient validation for profile images
    if (imageType === 'PROFILE') {
        return {
            minWidth: 32,  // Minimum width for profile images
            maxWidth: sizes.width * 8,
            minHeight: 32, // Minimum height for profile images
            maxHeight: sizes.height * 8,
            maxSize: typeConfig.maxSize,
            allowedFormats: [...typeConfig.formats],
            requireSquare: true, // Profile images should still be square
            maxAspectRatio: 1.1, // Allow slight deviation from square
            minAspectRatio: 0.9
        };
    }

    if (['CURATION_ICON','PACK_ICON','TAG_ICON'].includes(imageType)) {
        return {
            minWidth: 32,
            maxWidth: sizes.width * 8,
            minHeight: 32,
            maxHeight: sizes.height * 8,
            maxSize: typeConfig.maxSize,
            allowedFormats: [...typeConfig.formats],
            requireSquare: true,
            maxAspectRatio: 1.1,
            minAspectRatio: 0.9
        };
    }

    // Default validation for other image types
    return {
        minWidth: Math.min(sizes.width, sizes.height) * 0.5,
        maxWidth: sizes.width * 2,
        minHeight: Math.min(sizes.width, sizes.height) * 0.5,
        maxHeight: sizes.height * 2,
        maxSize: typeConfig.maxSize,
        allowedFormats: [...typeConfig.formats],
        requireSquare: false,
        maxAspectRatio: imageType === 'BANNER' ? 2 : 1.5,
        minAspectRatio: imageType === 'BANNER' ? 0.5 : 0.75
    };
}
