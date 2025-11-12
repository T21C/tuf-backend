import path from 'path';
import fs from 'fs';
import AdmZip from 'adm-zip';
import axios from 'axios';
import { logger } from '../../services/LoggerService.js';
import { storageManager } from '../services/storageManager.js';
import { CDN_CONFIG } from '../config.js';
import { processZipFile } from '../services/zipProcessor.js';
import { Request, Response, Router } from 'express';
import CdnFile from '../../models/cdn/CdnFile.js';
import crypto from 'crypto';
import LevelDict from 'adofai-lib';
import sequelize from '../../config/db.js';
import { Transaction } from 'sequelize';
import { safeTransactionRollback } from '../../utils/Utility.js';
import { levelCacheService } from '../services/levelCacheService.js';
import { hybridStorageManager, StorageType } from '../services/hybridStorageManager.js';

const router = Router();

const PACK_DOWNLOAD_DIR = path.join(CDN_CONFIG.user_root, 'pack-downloads');
const PACK_DOWNLOAD_TEMP_DIR = path.join(PACK_DOWNLOAD_DIR, 'temp');
const PACK_DOWNLOAD_TTL_MS = 60 * 60 * 1000; // 1 hour
const PACK_DOWNLOAD_CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

type PackDownloadNode = {
    type: 'folder' | 'level';
    name: string;
    children?: PackDownloadNode[];
    fileId?: string | null;
    sourceUrl?: string | null;
    levelId?: number | null;
    packItemId?: number | null;
};

type PackDownloadResponse = {
    downloadId: string;
    url: string;
    expiresAt: string;
    zipName: string;
    cacheKey: string;
};

interface PackDownloadEntry {
    filePath: string;
    expiresAt: number;
    zipName: string;
    cacheKey: string;
}

const packDownloadEntries = new Map<string, PackDownloadEntry>();
const packCacheIndex = new Map<string, string>();
const packGenerationPromises = new Map<string, Promise<PackDownloadResponse>>();

function sanitizePathSegment(name: string): string {
    const sanitized = (name || 'Item')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
    if (sanitized.length === 0) {
        return 'Item';
    }
    return sanitized.slice(0, 120);
}

function encodeContentDisposition(filename: string): string {
    const encoded = encodeURIComponent(filename);
    return `attachment; filename*=UTF-8''${encoded}`;
}

function buildLevelFolderName(node: PackDownloadNode, baseName: string): string {
    let sanitizedBase = sanitizePathSegment(baseName || 'Level');
    const idPrefixPattern = /^#\d+\s+/;
    if (idPrefixPattern.test(sanitizedBase)) {
        sanitizedBase = sanitizePathSegment(sanitizedBase.replace(idPrefixPattern, '').trim() || 'Level');
    }
    const withId = node.levelId != null
        ? `#${node.levelId} ${sanitizedBase}`
        : sanitizedBase;
    return sanitizePathSegment(withId);
}

function addDirectoryToZip(zip: AdmZip, directoryPath: string, folderSet: Set<string>) {
    const normalized = directoryPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized) {
        return;
    }
    const folderPath = normalized.endsWith('/') ? normalized : `${normalized}/`;
    if (folderSet.has(folderPath)) {
        return;
    }
    zip.addFile(folderPath, Buffer.alloc(0));
    folderSet.add(folderPath);
}

function getFilenameFromDisposition(disposition?: string): string | null {
    if (!disposition) return null;
    const filenameStarMatch = disposition.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
    if (filenameStarMatch) {
        try {
            return decodeURIComponent(filenameStarMatch[1].replace(/"/g, ''));
        } catch {
            return filenameStarMatch[1].replace(/"/g, '');
        }
    }
    const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
    return filenameMatch ? filenameMatch[1] : null;
}

async function ensurePackDownloadDirs(): Promise<void> {
    await fs.promises.mkdir(PACK_DOWNLOAD_DIR, { recursive: true });
    await fs.promises.mkdir(PACK_DOWNLOAD_TEMP_DIR, { recursive: true });
}

async function cleanupExpiredDownloads(): Promise<void> {
    const now = Date.now();
    for (const [downloadId, entry] of packDownloadEntries.entries()) {
        if (entry.expiresAt <= now) {
            try {
                if (fs.existsSync(entry.filePath)) {
                    await fs.promises.rm(entry.filePath, { force: true });
                }
            } catch (error) {
                logger.warn('Failed to remove expired pack download file', {
                    downloadId,
                    filePath: entry.filePath,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
            packDownloadEntries.delete(downloadId);
            if (packCacheIndex.get(entry.cacheKey) === downloadId) {
                packCacheIndex.delete(entry.cacheKey);
            }
        }
    }
}

async function initializePackDownloadStorage(): Promise<void> {
    await ensurePackDownloadDirs();
    await cleanupExpiredDownloads();
}

await initializePackDownloadStorage();
setInterval(() => {
    cleanupExpiredDownloads().catch(error => {
        logger.error('Failed to cleanup expired pack downloads:', {
            error: error instanceof Error ? error.message : String(error)
        });
    });
}, PACK_DOWNLOAD_CLEANUP_INTERVAL_MS);

interface PackGenerationContext {
    tempDir: string;
    targetZip: AdmZip;
    folderSet: Set<string>;
    successCount: number;
    totalLevels: number;
}

async function addZipEntriesToPack(sourceZip: AdmZip, targetFolder: string, context: PackGenerationContext) {
    const entries = sourceZip.getEntries();
    addDirectoryToZip(context.targetZip, targetFolder, context.folderSet);

    for (const entry of entries) {
        const rawEntryName = entry.entryName.replace(/\\/g, '/');
        if (!rawEntryName || rawEntryName.includes('..')) {
            continue;
        }
        const normalizedEntryName = rawEntryName.startsWith('/') ? rawEntryName.slice(1) : rawEntryName;
        const targetPath = targetFolder
            ? path.posix.join(targetFolder, normalizedEntryName)
            : normalizedEntryName;

        if (entry.isDirectory) {
            addDirectoryToZip(context.targetZip, targetPath, context.folderSet);
            continue;
        }

        const directoryName = path.posix.dirname(targetPath);
        if (directoryName && directoryName !== '.') {
            addDirectoryToZip(context.targetZip, directoryName, context.folderSet);
        }

        context.targetZip.addFile(targetPath, entry.getData());
    }
}

async function addLevelFromCdn(node: PackDownloadNode, parentPath: string, context: PackGenerationContext): Promise<{ folderName: string; success: boolean; }> {
    if (!node.fileId) {
        return { folderName: parentPath, success: false };
    }

    try {
        const cdnFile = await CdnFile.findByPk(node.fileId);
        if (!cdnFile || cdnFile.type !== 'LEVELZIP' || !cdnFile.metadata) {
            logger.warn('CDN file missing or invalid for pack download', {
                fileId: node.fileId
            });
            return { folderName: parentPath, success: false };
        }

        const metadata = cdnFile.metadata as any;
        const originalZip = metadata.originalZip;
        if (!originalZip?.path) {
            logger.warn('Original zip metadata missing for pack download', {
                fileId: node.fileId
            });
            return { folderName: parentPath, success: false };
        }

        const preferredStorage = originalZip.storageType || metadata.storageType || StorageType.LOCAL;
        const existence = await hybridStorageManager.fileExistsWithFallback(originalZip.path, preferredStorage);
        if (!existence.exists) {
            logger.warn('Original zip not found in storage for pack download', {
                fileId: node.fileId,
                path: originalZip.path
            });
            return { folderName: parentPath, success: false };
        }

        let sourceZip: AdmZip;
        if (existence.storageType === StorageType.SPACES) {
            const buffer = await hybridStorageManager.downloadFile(originalZip.path, StorageType.SPACES);
            sourceZip = new AdmZip(buffer);
        } else {
            sourceZip = new AdmZip(existence.actualPath);
        }

        const derivedName = originalZip.originalFilename || originalZip.name;
        const baseFolderName = derivedName
            ? path.parse(derivedName).name
            : node.name || `Level-${node.levelId ?? 'unknown'}`;
        const finalFolderName = buildLevelFolderName(node, baseFolderName);
        const targetFolder = parentPath
            ? path.posix.join(parentPath, finalFolderName)
            : finalFolderName;

        await addZipEntriesToPack(sourceZip, targetFolder, context);
        context.successCount += 1;
        return { folderName: targetFolder, success: true };
    } catch (error) {
        logger.error('Failed to add CDN level to pack download', {
            fileId: node.fileId,
            error: error instanceof Error ? error.message : String(error)
        });
        return { folderName: parentPath, success: false };
    }
}

async function addLevelFromUrl(node: PackDownloadNode, parentPath: string, context: PackGenerationContext): Promise<{ folderName: string; success: boolean; }> {
    if (!node.sourceUrl) {
        return { folderName: parentPath, success: false };
    }

    try {
        const response = await axios.get(node.sourceUrl, {
            responseType: 'arraybuffer',
            timeout: 10_000
        });

        const buffer = Buffer.from(response.data);
        const sourceZip = new AdmZip(buffer);
        const defaultName = node.name || `Level-${node.levelId ?? 'unknown'}`;

        const dispositionFilename = getFilenameFromDisposition(response.headers['content-disposition']);
        const urlFilename = (() => {
            try {
                const url = new URL(node.sourceUrl!);
                return decodeURIComponent(path.basename(url.pathname));
            } catch {
                return null;
            }
        })();

        const rawName = dispositionFilename || urlFilename || defaultName;
        const baseFolderName = path.parse(rawName).name || rawName;
        const finalFolderName = buildLevelFolderName(node, baseFolderName);
        const targetFolder = parentPath
            ? path.posix.join(parentPath, finalFolderName)
            : finalFolderName;

        await addZipEntriesToPack(sourceZip, targetFolder, context);
        context.successCount += 1;
        return { folderName: targetFolder, success: true };
    } catch (error) {
        logger.debug('Failed to download external level for pack generation', {
            sourceUrl: node.sourceUrl,
            error: error instanceof Error ? error.message : String(error)
        });
        return { folderName: parentPath, success: false };
    }
}

async function processPackNode(node: PackDownloadNode, parentPath: string, context: PackGenerationContext): Promise<void> {
    if (node.type === 'folder') {
        const folderName = sanitizePathSegment(node.name || 'Folder');
        const folderPath = parentPath
            ? path.posix.join(parentPath, folderName)
            : folderName;

        addDirectoryToZip(context.targetZip, folderPath, context.folderSet);

        if (Array.isArray(node.children) && node.children.length > 0) {
            const children = node.children as PackDownloadNode[];
            await Promise.all(children.map(child => processPackNode(child, folderPath, context)));
        }
        return;
    }

    context.totalLevels += 1;
    const baseName = sanitizePathSegment(node.name || `Level-${node.levelId ?? 'unknown'}`);
    const targetBasePath = parentPath ? path.posix.join(parentPath, baseName) : baseName;

    let successResult: { folderName: string; success: boolean; } = { folderName: targetBasePath, success: false };
    if (node.fileId) {
        successResult = await addLevelFromCdn(node, parentPath, context);
    } else if (node.sourceUrl) {
        successResult = await addLevelFromUrl(node, parentPath, context);
    }

    if (!successResult.success) {
        const failedName = sanitizePathSegment(`[FAILED] ${baseName}`);
        const failedPath = parentPath
            ? path.posix.join(parentPath, failedName)
            : failedName;
        addDirectoryToZip(context.targetZip, failedPath, context.folderSet);
    }
}

async function generatePackDownloadZip(zipName: string, tree: PackDownloadNode, cacheKey: string): Promise<PackDownloadResponse> {
    await ensurePackDownloadDirs();
    await cleanupExpiredDownloads();

    const packZip = new AdmZip();
    const folderSet = new Set<string>();
    const tempDir = path.join(PACK_DOWNLOAD_TEMP_DIR, crypto.randomUUID());
    await fs.promises.mkdir(tempDir, { recursive: true });

    const context: PackGenerationContext = {
        tempDir,
        targetZip: packZip,
        folderSet,
        successCount: 0,
        totalLevels: 0
    };

    try {
        await processPackNode(tree, '', context);

        const downloadId = crypto.randomUUID();
        const zipFilename = `${downloadId}.zip`;
        const targetPath = path.join(PACK_DOWNLOAD_DIR, zipFilename);
        packZip.writeZip(targetPath);

        const expiresAt = Date.now() + PACK_DOWNLOAD_TTL_MS;
        const response: PackDownloadResponse = {
            downloadId,
            url: `${CDN_CONFIG.baseUrl}/zips/packs/downloads/${downloadId}`,
            expiresAt: new Date(expiresAt).toISOString(),
            zipName,
            cacheKey
        };

        packDownloadEntries.set(downloadId, {
            filePath: targetPath,
            expiresAt,
            zipName,
            cacheKey
        });
        packCacheIndex.set(cacheKey, downloadId);

        logger.debug('Generated pack download zip', {
            downloadId,
            zipName,
            cacheKey,
            successLevels: context.successCount,
            totalLevels: context.totalLevels,
            expiresAt: response.expiresAt,
            filePath: targetPath
        });

        return response;
    } finally {
        try {
            if (fs.existsSync(tempDir)) {
                await fs.promises.rm(tempDir, { recursive: true, force: true });
            }
        } catch (error) {
            logger.warn('Failed to cleanup temporary directory for pack download', {
                tempDir,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }
}

function isPackDownloadNode(node: any): node is PackDownloadNode {
    if (!node || typeof node !== 'object') {
        return false;
    }

    if (node.type === 'folder') {
        if (typeof node.name !== 'string') {
            return false;
        }
        if (node.children === undefined) {
            return true;
        }
        if (!Array.isArray(node.children)) {
            return false;
        }
        return (node.children as PackDownloadNode[]).every((child: PackDownloadNode) => isPackDownloadNode(child));
    }

    if (node.type === 'level') {
        return typeof node.name === 'string';
    }

    return false;
}

// Get level files in a zip
router.get('/:fileId/levels', async (req: Request, res: Response) => {
    const { fileId } = req.params;

    logger.debug('Getting level files for zip:', { fileId });

    try {
        const levelEntry = await CdnFile.findByPk(fileId);
        if (!levelEntry || !levelEntry.metadata) {
            logger.error('Level entry not found or invalid:', {
                fileId,
                hasEntry: !!levelEntry,
                hasMetadata: !!levelEntry?.metadata
            });
            return res.status(404).json({ error: 'Level entry not found' });
        }

        const { allLevelFiles } = levelEntry.metadata as {
            allLevelFiles: Array<{
                name: string;
                path: string;
                size: number;
                hasYouTubeStream?: boolean;
                songFilename?: string;
            }>;
        };

        if (!allLevelFiles || !Array.isArray(allLevelFiles)) {
            logger.error('No level files found in metadata:', { fileId });
            return res.status(404).json({ error: 'No level files found' });
        }

        // Get fresh analysis for each level file
        const levelFiles = await Promise.all(allLevelFiles.map(async (file) => {
            try {
                // Normalize the path to use forward slashes and ensure it's absolute
                const normalizedPath = path.isAbsolute(file.path)
                    ? file.path.replace(/\\/g, '/')
                    : path.resolve(file.path).replace(/\\/g, '/');

                const levelDict = new LevelDict(normalizedPath);

                return {
                    name: file.name,
                    size: file.size,
                    hasYouTubeStream: levelDict.getSetting('requiredMods')?.includes('YouTubeStream'),
                    songFilename: levelDict.getSetting('songFilename'),
                    artist: levelDict.getSetting('artist'),
                    song: levelDict.getSetting('song'),
                    author: levelDict.getSetting('author'),
                    difficulty: levelDict.getSetting('difficulty'),
                    bpm: levelDict.getSetting('bpm')
                };
            } catch (error) {
                logger.error('Failed to analyze level file:', {
                    error: error instanceof Error ? error.message : String(error),
                    path: file.path,
                    normalizedPath: path.isAbsolute(file.path)
                        ? file.path.replace(/\\/g, '/')
                        : path.resolve(file.path).replace(/\\/g, '/')
                });
                return {
                    name: file.name,
                    size: file.size,
                    error: 'Failed to analyze level file'
                };
            }
        }));

        logger.debug('Successfully retrieved level files:', {
            fileId,
            count: levelFiles.length
        });

        res.json({
            success: true,
            fileId,
            levels: levelFiles
        });
    } catch (error) {
        logger.error('Error getting level files:', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            fileId
        });
        res.status(500).json({ error: 'Failed to get level files' });
    }
    return;
});

router.post('/packs/generate', async (req: Request, res: Response) => {
    try {
        const { zipName, tree, cacheKey } = req.body ?? {};

        if (!zipName || typeof zipName !== 'string') {
            return res.status(400).json({ error: 'zipName is required' });
        }
        if (!tree || !isPackDownloadNode(tree)) {
            return res.status(400).json({ error: 'Valid download tree is required' });
        }

        const normalizedCacheKey = typeof cacheKey === 'string' && cacheKey.length > 0
            ? cacheKey
            : crypto.createHash('sha256').update(JSON.stringify({ zipName, tree })).digest('hex');

        const existingDownloadId = packCacheIndex.get(normalizedCacheKey);
        if (existingDownloadId) {
            const entry = packDownloadEntries.get(existingDownloadId);
            if (entry && entry.expiresAt > Date.now() && fs.existsSync(entry.filePath)) {
                return res.json({
                    downloadId: existingDownloadId,
                    url: `${CDN_CONFIG.baseUrl}/zips/packs/downloads/${existingDownloadId}`,
                    expiresAt: new Date(entry.expiresAt).toISOString(),
                    zipName: entry.zipName,
                    cacheKey: entry.cacheKey
                });
            }
            packCacheIndex.delete(normalizedCacheKey);
            packDownloadEntries.delete(existingDownloadId);
        }

        if (!packGenerationPromises.has(normalizedCacheKey)) {
            const sanitizedZipName = sanitizePathSegment(zipName);
            const generationPromise = (async () => {
                try {
                    return await generatePackDownloadZip(sanitizedZipName, tree, normalizedCacheKey);
                } finally {
                    packGenerationPromises.delete(normalizedCacheKey);
                }
            })();

            packGenerationPromises.set(normalizedCacheKey, generationPromise);
        }

        const responsePayload = await packGenerationPromises.get(normalizedCacheKey)!;
        return res.json(responsePayload);
    } catch (error) {
        logger.error('Failed to generate pack download zip', {
            error: error instanceof Error ? error.message : String(error)
        });
        return res.status(500).json({
            error: 'Failed to generate pack download',
            code: 'PACK_DOWNLOAD_ERROR'
        });
    }
});

router.get('/packs/downloads/:id', async (req: Request, res: Response) => {
    try {
        await cleanupExpiredDownloads();

        const { id } = req.params;
        const entry = packDownloadEntries.get(id);
        if (!entry) {
            return res.status(404).json({ error: 'Download not found' });
        }

        if (entry.expiresAt <= Date.now()) {
            if (fs.existsSync(entry.filePath)) {
                await fs.promises.rm(entry.filePath, { force: true });
            }
            packDownloadEntries.delete(id);
            if (packCacheIndex.get(entry.cacheKey) === id) {
                packCacheIndex.delete(entry.cacheKey);
            }
            return res.status(404).json({ error: 'Download expired' });
        }

        if (!fs.existsSync(entry.filePath)) {
            packDownloadEntries.delete(id);
            if (packCacheIndex.get(entry.cacheKey) === id) {
                packCacheIndex.delete(entry.cacheKey);
            }
            return res.status(404).json({ error: 'Download not found' });
        }

        const stat = await fs.promises.stat(entry.filePath);
        const range = req.headers.range;
        const zipBaseName = sanitizePathSegment(entry.zipName || 'pack-download');
        const filename = zipBaseName.endsWith('.zip') ? zipBaseName : `${zipBaseName}.zip`;

        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Disposition', encodeContentDisposition(filename));
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Expires', new Date(entry.expiresAt).toUTCString());

        if (range) {
            const match = /bytes=(\d*)-(\d*)/.exec(range);
            if (!match) {
                res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
                return res.end();
            }
            const start = match[1] ? parseInt(match[1], 10) : 0;
            const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;

            if (isNaN(start) || isNaN(end) || start > end || end >= stat.size) {
                res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
                return res.end();
            }

            const chunkSize = end - start + 1;
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
            res.setHeader('Content-Length', chunkSize.toString());

            const stream = fs.createReadStream(entry.filePath, { start, end });
            stream.on('error', (error) => {
                logger.error('Error streaming pack download (range)', {
                    downloadId: id,
                    error: error instanceof Error ? error.message : String(error)
                });
                res.destroy(error as Error);
            });
            stream.pipe(res);
            return;
        }

        res.status(200);
        res.setHeader('Content-Length', stat.size.toString());
        const stream = fs.createReadStream(entry.filePath);
        stream.on('error', (error) => {
            logger.error('Error streaming pack download', {
                downloadId: id,
                error: error instanceof Error ? error.message : String(error)
            });
            res.destroy(error as Error);
        });
        stream.pipe(res);
        return;
    } catch (error) {
        logger.error('Failed to serve pack download zip', {
            downloadId: req.params.id,
            error: error instanceof Error ? error.message : String(error)
        });
        return res.status(500).json({ error: 'Failed to serve download' });
    }
});

// Level zip upload endpoint
router.post('/', (req: Request, res: Response) => {
    logger.debug('Received zip upload request');

    storageManager.upload(req, res, async (err) => {
        if (err) {
            logger.error('Multer error during zip upload:', {
                error: err.message,
                code: err.code,
                field: err.field,
                stack: err.stack
            });
            return res.status(400).json({ error: err.message });
        }

        if (!req.file) {
            logger.warn('Zip upload attempt with no file');
            return res.status(400).json({ error: 'No file uploaded' });
        }

        logger.debug('Processing uploaded zip file:', {
            filename: req.file.filename,
            size: req.file.size,
            mimetype: req.file.mimetype,
            path: req.file.path
        });

        try {
            // Generate a UUID for the database entry
            const fileId = crypto.randomUUID();
            logger.debug('Generated UUID for database entry:', { fileId });

            // Process zip file first to validate contents
            logger.debug('Starting zip file processing');
            await processZipFile(req.file.path, fileId, req.file.originalname);
            logger.debug('Successfully processed zip file');

            // Clean up the original zip file since we've extracted what we need
            logger.debug('Cleaning up original zip file');
            storageManager.cleanupFiles(req.file.path);
            logger.debug('Original zip file cleaned up');

            // Populate cache for the uploaded level
            logger.debug('Populating cache for uploaded level:', { fileId });
            try {
                await levelCacheService.ensureCachePopulated(fileId);
                logger.debug('Cache populated successfully for uploaded level:', { fileId });
            } catch (cacheError) {
                // Log error but don't fail the upload
                logger.warn('Failed to populate cache for uploaded level (non-critical):', {
                    fileId,
                    error: cacheError instanceof Error ? cacheError.message : String(cacheError)
                });
            }

            const response = {
                success: true,
                fileId: fileId,
                url: `${CDN_CONFIG.baseUrl}/${fileId}`,
            };
            logger.debug('Zip upload completed successfully:', response);

            res.json(response);
        } catch (error) {
            logger.error('Error during zip upload process:', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                file: req.file ? {
                    originalname: req.file.originalname,
                    size: req.file.size,
                    path: req.file.path
                } : null
            });

            storageManager.cleanupFiles(req.file.path);

            // Try to parse error message if it's JSON
            let errorDetails;
            try {
                const parsedError = JSON.parse(error instanceof Error ? error.message : String(error));
                errorDetails = {
                    message: parsedError.details?.message || parsedError.message,
                    ...parsedError.details
                };
            } catch {
                errorDetails = {
                    message: error instanceof Error ? error.message : String(error)
                };
            }

            res.status(400).json({
                error: errorDetails.message,
                code: 'VALIDATION_ERROR',
                details: errorDetails
            });
        }
        return;
    });
    return;
});

// Set target level endpoint
router.put('/:fileId/target-level', async (req: Request, res: Response) => {
    const { fileId } = req.params;
    const { targetLevel } = req.body;
    let transaction: Transaction | undefined;

    logger.debug('Setting target level for zip:', { fileId, targetLevel });

    try {
        // Start transaction
        transaction = await sequelize.transaction();

        const levelEntry = await CdnFile.findByPk(fileId, { transaction });
        if (!levelEntry || !levelEntry.metadata) {
            await safeTransactionRollback(transaction);
            logger.error('Level entry not found or invalid:', {
                fileId,
                hasEntry: !!levelEntry,
                hasMetadata: !!levelEntry?.metadata
            });
            return res.status(404).json({ error: 'Level entry not found' });
        }

        const metadata = levelEntry.metadata as {
            allLevelFiles: Array<{
                name: string;
                path: string;
                size: number;
                hasYouTubeStream?: boolean;
                songFilename?: string;
            }>;
            targetLevel: string | null;
            pathConfirmed: boolean;
        };

        // Get the target filename regardless of path
        const targetFilename = path.basename(targetLevel);

        // Find matching level file by recursively checking paths
        const matchingLevel = metadata.allLevelFiles.find(file => {
            const filePath = file.path.replace(/\\/g, '/');
            const targetPath = targetLevel.replace(/\\/g, '/');

            // Direct path match
            if (filePath === targetPath) {
                return true;
            }

            // Filename match
            if (path.basename(filePath) === targetFilename) {
                return true;
            }

            // Check if target is a relative path and matches any subdirectory
            if (!path.isAbsolute(targetPath)) {
                const fileDir = path.dirname(filePath);
                const targetDir = path.dirname(targetPath);
                return fileDir.endsWith(targetDir) && path.basename(filePath) === targetFilename;
            }

            return false;
        });

        if (!matchingLevel) {
            await safeTransactionRollback(transaction);
            logger.error('Target level not found in zip:', {
                fileId,
                targetLevel,
                targetFilename,
                availableLevels: metadata.allLevelFiles.map(f => ({
                    path: f.path,
                    name: f.name
                }))
            });
            return res.status(400).json({ error: 'Target level not found in zip' });
        }

        // Update metadata with the actual file path from the zip within transaction
        // Clear cache since target level has changed (will be repopulated after commit)
        await levelEntry.update({
            metadata: {
                ...metadata,
                targetLevel: matchingLevel.path,
                pathConfirmed: true,
                targetSafeToParse: false
            },
            cacheData: null
        }, { transaction });

        // Commit the transaction
        await transaction.commit();

        logger.debug('Successfully set target level:', {
            fileId,
            targetLevel: matchingLevel.path,
            originalTarget: targetLevel,
            timestamp: new Date().toISOString()
        });

        // Repopulate cache for the new target level
        logger.debug('Repopulating cache for new target level:', { fileId });
        try {
            // Reload the file to get the updated metadata
            await levelEntry.reload();
            await levelCacheService.ensureCachePopulated(fileId);
            logger.debug('Cache repopulated successfully for new target level:', { fileId });
        } catch (cacheError) {
            // Log error but don't fail the request
            logger.warn('Failed to repopulate cache for new target level (non-critical):', {
                fileId,
                error: cacheError instanceof Error ? cacheError.message : String(cacheError)
            });
        }

        res.json({
            success: true,
            fileId,
            targetLevel: matchingLevel.path
        });
    } catch (error) {
        // Rollback transaction if it exists
        if (transaction) {
            try {
                await safeTransactionRollback(transaction);
            } catch (rollbackError) {
                logger.warn('Transaction rollback failed:', rollbackError);
            }
        }

        logger.error('Error setting target level:', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            fileId,
            targetLevel,
            timestamp: new Date().toISOString()
        });
        res.status(500).json({ error: 'Failed to set target level' });
    }
    return;
});

export default router;
