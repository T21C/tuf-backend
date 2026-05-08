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

/** PROFILE GIF: variant keys use `original_animated`, `large_animated`, … and `original_static`, … (no extension in URL segment). */
async function processProfileGifAnimatedAndStatic(
    filePath: string,
    fileId: string,
    outputDirectory: string,
    imageConfig: (typeof IMAGE_TYPES)['PROFILE'],
): Promise<Record<string, { path: string; mimeType: string }>> {
    const processedFiles: Record<string, { path: string; mimeType: string }> = {};
    const gifBuffer = await fs.promises.readFile(filePath);
    const meta = await sharp(filePath).metadata();
    const innerW = meta.width ?? 0;
    const innerH = meta.height ?? 0;
    const gifExt = path.extname(filePath) || '.gif';

    for (const [size, dimensions] of Object.entries(imageConfig.sizes)) {
        const animKey = size === 'original' ? 'original_animated' : `${size}_animated`;
        if (size === 'original') {
            const outputPath = path.join(outputDirectory, `${animKey}${gifExt}`);
            await fs.promises.copyFile(filePath, outputPath);
            processedFiles[animKey] = metaForVariant(imageConfig.name, fileId, filePath, animKey);
            continue;
        }

        const outputPath = path.join(outputDirectory, `${animKey}${gifExt}`);
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

        processedFiles[animKey] = metaForVariant(imageConfig.name, fileId, filePath, animKey);
    }

    for (const [size, dimensions] of Object.entries(imageConfig.sizes)) {
        const staticKey = size === 'original' ? 'original_static' : `${size}_static`;
        const outBasename = size === 'original' ? 'original_static.jpg' : `${size}_static.jpg`;
        const outputPath = path.join(outputDirectory, outBasename);
        const dw = dimensions.width;
        const dh = dimensions.height;
        await sharp(filePath, { animated: true, pages: 1 })
            .resize(dw, dh, {
                fit: 'inside',
                withoutEnlargement: true,
            })
            .jpeg({ quality: 88 })
            .toFile(outputPath);
        processedFiles[staticKey] = {
            path: `images/${imageConfig.name}/${fileId}/${outBasename}`,
            mimeType: 'image/jpeg',
        };
    }

    return processedFiles;
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

    if (isGif && imageType === 'PROFILE') {
        const profileGif = await processProfileGifAnimatedAndStatic(
            filePath,
            fileId,
            outputDirectory,
            imageConfig as (typeof IMAGE_TYPES)['PROFILE'],
        );
        Object.assign(processedFiles, profileGif);
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
