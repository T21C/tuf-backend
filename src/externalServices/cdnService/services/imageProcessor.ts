import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import gifResize from '@gumlet/gif-resize';
import { IMAGE_TYPES, ImageType } from '../config.js';

/** MIME type for Spaces / HTTP from a file extension (with dot). */
export function mimeTypeForImageExtension(extWithDot: string): string {
    const e = extWithDot.toLowerCase();
    if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
    if (e === '.png') return 'image/png';
    if (e === '.webp') return 'image/webp';
    if (e === '.gif') return 'image/gif';
    if (e === '.svg') return 'image/svg+xml';
    return 'image/png';
}

function metaForVariant(
    imageConfigName: string,
    fileId: string,
    filePath: string,
    sizeName: string
): { path: string; mimeType: string } {
    const ext = path.extname(filePath).toLowerCase() || '.png';
    return {
        path: `images/${imageConfigName}/${fileId}/${sizeName}${ext}`,
        mimeType: mimeTypeForImageExtension(ext),
    };
}

export async function processImage(
    filePath: string,
    imageType: ImageType,
    fileId: string,
    outputDirectory: string
) {
    const imageConfig = IMAGE_TYPES[imageType];
    const processedFiles: Record<string, { path: string; mimeType: string }> = {};
    const ext = path.extname(filePath).toLowerCase();
    const isGif = ext === '.gif';
    const isSvg = ext === '.svg';

    // Create directory for this image's versions
    if (!fs.existsSync(outputDirectory)) {
        throw new Error('Output directory does not exist');
    }

    if (isSvg) {
        const svgBuf = await fs.promises.readFile(filePath);
        for (const [size] of Object.entries(imageConfig.sizes)) {
            const outputPath = path.join(outputDirectory, `${size}${ext}`);
            await fs.promises.writeFile(outputPath, svgBuf);
            processedFiles[size] = metaForVariant(imageConfig.name, fileId, filePath, size);
        }
        return processedFiles;
    }

    if (isGif) {
        const gifBuffer = await fs.promises.readFile(filePath);
        const meta = await sharp(filePath).metadata();
        const innerW = meta.width ?? 0;
        const innerH = meta.height ?? 0;

        for (const [size, dimensions] of Object.entries(imageConfig.sizes)) {
            if (size === 'original') {
                processedFiles[size] = metaForVariant(imageConfig.name, fileId, filePath, size);
                continue;
            }

            const outputPath = path.join(outputDirectory, `${size}${path.extname(filePath)}`);
            const dw = dimensions.width;
            const dh = dimensions.height;

            if (innerW > 0 && innerH > 0 && innerW <= dw && innerH <= dh) {
                await fs.promises.copyFile(filePath, outputPath);
            } else {
                const resized = await gifResize({
                    width: dw,
                    height: dh,
                    stretch: false
                })(gifBuffer);
                await fs.promises.writeFile(outputPath, resized);
            }

            processedFiles[size] = metaForVariant(imageConfig.name, fileId, filePath, size);
        }

        return processedFiles;
    }

    const image = sharp(filePath);

    // Process each size
    for (const [size, dimensions] of Object.entries(imageConfig.sizes)) {
        if (size === 'original') {
            processedFiles[size] = metaForVariant(imageConfig.name, fileId, filePath, size);
            continue;
        }

        const outputPath = path.join(outputDirectory, `${size}${path.extname(filePath)}`);

        await image
            .clone()
            .resize(dimensions.width, dimensions.height, {
                fit: 'inside',
                withoutEnlargement: true
            })
            .toFile(outputPath);

        processedFiles[size] = metaForVariant(imageConfig.name, fileId, filePath, size);
    }

    return processedFiles;
}
