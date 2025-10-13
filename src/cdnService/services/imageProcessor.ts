import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { CDN_CONFIG, IMAGE_TYPES, ImageType } from '../config.js';

export async function processImage(filePath: string, imageType: ImageType, fileId: string) {
    const imageConfig = IMAGE_TYPES[imageType];
    const image = sharp(filePath);
    const processedFiles: Record<string, { path: string; mimeType: string }> = {};

    // Create directory for this image's versions
    const imageDir = path.join(CDN_CONFIG.user_root, 'images', imageConfig.name, fileId);
    fs.mkdirSync(imageDir, { recursive: true });

    // Process each size
    for (const [size, dimensions] of Object.entries(imageConfig.sizes)) {
        if (size === 'original') {
            processedFiles[size] = {
                path: `images/${imageConfig.name}/${fileId}/${size}${path.extname(filePath)}`,
                mimeType: `image/${path.extname(filePath).slice(1)}`
            };
            continue;
        }

        const outputPath = path.join(imageDir, `${size}${path.extname(filePath)}`);

        await image
            .clone()
            .resize(dimensions.width, dimensions.height, {
                fit: 'inside',
                withoutEnlargement: true
            })
            .toFile(outputPath);

        processedFiles[size] = {
            path: `images/${imageConfig.name}/${fileId}/${size}${path.extname(filePath)}`,
            mimeType: `image/${path.extname(filePath).slice(1)}`
        };
    }

    return processedFiles;
}
