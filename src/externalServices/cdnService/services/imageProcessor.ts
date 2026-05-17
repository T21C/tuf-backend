import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import type { Sharp } from 'sharp';
import gifResize from '@gumlet/gif-resize';
import { IMAGE_TYPES, ImageType } from '../config.js';

type RasterOutputExt = '.jpg' | '.png' | '.webp';

/** Normalize upload extension to a supported raster output extension. */
export function normalizeRasterOutputExt(extWithDot: string): RasterOutputExt {
    const ext = extWithDot.toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return '.jpg';
    if (ext === '.webp') return '.webp';
    return '.png';
}

/** Prefer the on-disk extension; fall back to Sharp-detected format when missing. */
export function resolveRasterOutputExt(filePath: string, metadata?: sharp.Metadata): RasterOutputExt {
    const fromPath = path.extname(filePath);
    if (fromPath) {
        return normalizeRasterOutputExt(fromPath);
    }
    const format = metadata?.format?.toLowerCase();
    if (format === 'jpeg' || format === 'jpg') return '.jpg';
    if (format === 'webp') return '.webp';
    return '.png';
}

/** Apply an explicit encoder so resized output matches the source format (alpha-safe for PNG/WebP). */
export function encodeRasterVariant(pipeline: Sharp, outputExt: RasterOutputExt): Sharp {
    switch (outputExt) {
        case '.jpg':
            return pipeline.flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality: 88 });
        case '.webp':
            return pipeline.webp({ quality: 88, effort: 4 });
        case '.png':
        default:
            return pipeline.png();
    }
}

async function writeResizedRasterVariant(
    inputPath: string,
    outputPath: string,
    width: number,
    height: number,
    outputExt: RasterOutputExt,
): Promise<void> {
    const pipeline = sharp(inputPath).resize(width, height, {
        fit: 'inside',
        withoutEnlargement: true,
    });
    await encodeRasterVariant(pipeline, outputExt).toFile(outputPath);
}

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

    const staticOutputExt: RasterOutputExt = meta.hasAlpha ? '.png' : '.jpg';

    for (const [size, dimensions] of Object.entries(imageConfig.sizes)) {
        const staticKey = size === 'original' ? 'original_static' : `${size}_static`;
        const outBasename =
            size === 'original'
                ? `original_static${staticOutputExt}`
                : `${size}_static${staticOutputExt}`;
        const outputPath = path.join(outputDirectory, outBasename);
        const dw = dimensions.width;
        const dh = dimensions.height;
        const staticFrame = sharp(filePath, { animated: true, pages: 1 }).resize(dw, dh, {
            fit: 'inside',
            withoutEnlargement: true,
        });
        await encodeRasterVariant(staticFrame, staticOutputExt).toFile(outputPath);
        processedFiles[staticKey] = {
            path: `images/${imageConfig.name}/${fileId}/${outBasename}`,
            mimeType: mimeTypeForImageExtension(staticOutputExt),
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

    const metadata = await sharp(filePath).metadata();
    const outputExt = resolveRasterOutputExt(filePath, metadata);

    for (const [size, dimensions] of Object.entries(imageConfig.sizes)) {
        if (size === 'original') {
            processedFiles[size] = metaForVariant(imageConfig.name, fileId, filePath, size);
            continue;
        }

        const outputPath = path.join(outputDirectory, `${size}${outputExt}`);

        await writeResizedRasterVariant(
            filePath,
            outputPath,
            dimensions.width,
            dimensions.height,
            outputExt,
        );

        processedFiles[size] = metaForVariant(imageConfig.name, fileId, outputPath, size);
    }

    return processedFiles;
}
