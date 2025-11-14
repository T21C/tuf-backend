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
import { spacesStorage } from '../services/spacesStorage.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const router = Router();

const execAsync = promisify(exec);
const isWindows = process.platform === 'win32';

const PACK_DOWNLOAD_DIR = path.join(CDN_CONFIG.user_root, 'pack-downloads');
const PACK_DOWNLOAD_TEMP_DIR = path.join(PACK_DOWNLOAD_DIR, 'temp');
const PACK_DOWNLOAD_TTL_MS = 60 * 60 * 1000; // 1 hour
const PACK_DOWNLOAD_CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const PACK_DOWNLOAD_SPACES_PREFIX = 'pack-downloads';

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
    filePath?: string | null;
    expiresAt: number;
    zipName: string;
    cacheKey: string;
    spacesKey?: string | null;
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

async function cleanupPackDownloadSpaces(): Promise<void> {
    try {
        const files = await spacesStorage.listFiles(`${PACK_DOWNLOAD_SPACES_PREFIX}/`, 1000);
        // Handle both old format (pack-downloads/{uuid}.zip) and new format (pack-downloads/{uuid}/{name}.zip)
        const keysToDelete = files
            .filter(file => file.key.endsWith('.zip'))
            .filter(file => {
                const parts = file.key.split('/');
                // Old format: 2 parts (pack-downloads, uuid.zip)
                // New format: 3 parts (pack-downloads, uuid, name.zip)
                return parts.length === 2 || parts.length === 3;
            })
            .map(file => file.key);

        if (keysToDelete.length > 0) {
            await spacesStorage.deleteFiles(keysToDelete);
            logger.debug('Cleaned up pack download files in Spaces', {
                deleted: keysToDelete.length
            });
        }
    } catch (error) {
        logger.error('Failed to cleanup pack download files in Spaces', {
            error: error instanceof Error ? error.message : String(error)
        });
    }
}

async function cleanupExpiredDownloads(): Promise<void> {
    const now = Date.now();
    for (const [downloadId, entry] of packDownloadEntries.entries()) {
        if (entry.expiresAt <= now) {
            try {
                if (entry.filePath && fs.existsSync(entry.filePath)) {
                    await fs.promises.rm(entry.filePath, { force: true });
                }
            } catch (error) {
                logger.warn('Failed to remove expired pack download file', {
                    downloadId,
                    filePath: entry.filePath,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
            if (entry.spacesKey) {
                try {
                    await spacesStorage.deleteFile(entry.spacesKey);
                } catch (error) {
                    logger.warn('Failed to remove expired pack download file from Spaces', {
                        downloadId,
                        spacesKey: entry.spacesKey,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
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
await cleanupPackDownloadSpaces();
setInterval(() => {
    cleanupExpiredDownloads().catch(error => {
        logger.error('Failed to cleanup expired pack downloads:', {
            error: error instanceof Error ? error.message : String(error)
        });
    });
}, PACK_DOWNLOAD_CLEANUP_INTERVAL_MS);

interface PackGenerationContext {
    tempDir: string;
    extractRoot: string;
    successCount: number;
    totalLevels: number;
}

async function streamSpacesFileToDisk(spacesKey: string, targetPath: string): Promise<void> {
    // Use S3's createReadStream directly to avoid loading into memory
    // Access the S3 client and config through spacesStorage
    const s3 = (spacesStorage as any).s3;
    const bucket = (spacesStorage as any).config?.bucket;
    
    if (!s3 || !bucket) {
        throw new Error('Failed to access Spaces storage configuration');
    }
    
    const params = {
        Bucket: bucket,
        Key: spacesKey
    };
    
    // Create a true stream from S3 (not using .promise() which loads into memory)
    const stream = s3.getObject(params).createReadStream();
    const writeStream = fs.createWriteStream(targetPath);
    
    return new Promise<void>((resolve, reject) => {
        stream.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', (error: Error) => {
            stream.destroy();
            reject(error);
        });
        stream.on('error', (error: Error) => {
            writeStream.destroy();
            reject(error);
        });
    });
}

async function extractZipToFolder(zipPath: string, extractTo: string): Promise<void> {
    await fs.promises.mkdir(extractTo, { recursive: true });
    
    const sevenZipPath = '7z';
    let cmd: string;
    
    if (isWindows) {
        cmd = `"${sevenZipPath}" x "${zipPath}" -o"${extractTo}" -y`;
    } else {
        cmd = `unzip -o "${zipPath}" -d "${extractTo}"`;
    }
    
    try {
        await execAsync(cmd, {
            shell: isWindows ? 'cmd.exe' : '/bin/bash',
            maxBuffer: 1024 * 1024 * 100 // 100MB buffer for stdout/stderr
        });
    } catch (error) {
        logger.error('Failed to extract zip using 7z/unzip, falling back to AdmZip', {
            zipPath,
            extractTo,
            error: error instanceof Error ? error.message : String(error)
        });
        // Fallback to AdmZip if 7z/unzip fails
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(extractTo, true);
    }
}

async function addDirectoryToZipRecursive(zip: AdmZip, dirPath: string, zipPath: string): Promise<void> {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const entryZipPath = zipPath ? path.posix.join(zipPath, entry.name) : entry.name;
        
        if (entry.isDirectory()) {
            zip.addFile(entryZipPath + '/', Buffer.alloc(0));
            await addDirectoryToZipRecursive(zip, fullPath, entryZipPath);
        } else {
            const fileBuffer = await fs.promises.readFile(fullPath);
            zip.addFile(entryZipPath, fileBuffer);
        }
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

        // Stream zip to temp file if from Spaces, otherwise use local path
        let zipPath: string;
        if (existence.storageType === StorageType.SPACES) {
            const tempZipPath = path.join(context.tempDir, `level-${node.fileId}-${crypto.randomUUID()}.zip`);
            // Stream directly from Spaces to disk without loading into memory
            await streamSpacesFileToDisk(originalZip.path, tempZipPath);
            zipPath = tempZipPath;
        } else {
            zipPath = existence.actualPath;
        }

        const derivedName = originalZip.originalFilename || originalZip.name;
        const baseFolderName = derivedName
            ? path.parse(derivedName).name
            : node.name || `Level-${node.levelId ?? 'unknown'}`;
        const finalFolderName = buildLevelFolderName(node, baseFolderName);
        const targetFolder = parentPath
            ? path.join(context.extractRoot, parentPath, finalFolderName)
            : path.join(context.extractRoot, finalFolderName);

        // Extract zip to target folder on disk
        await extractZipToFolder(zipPath, targetFolder);

        // Clean up temp zip file if we created one
        if (existence.storageType === StorageType.SPACES && zipPath !== existence.actualPath) {
            try {
                await fs.promises.unlink(zipPath);
            } catch (cleanupError) {
                logger.warn('Failed to cleanup temp zip file', {
                    zipPath,
                    error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
                });
            }
        }

        context.successCount += 1;
        const relativeFolderName = parentPath
            ? path.posix.join(parentPath, finalFolderName)
            : finalFolderName;
        return { folderName: relativeFolderName, success: true };
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
        // Download zip to temp file
        const tempZipPath = path.join(context.tempDir, `url-level-${crypto.randomUUID()}.zip`);
        const response = await axios.get(node.sourceUrl, {
            responseType: 'stream',
            timeout: 30_000 // Increased timeout for large files
        });

        const writeStream = fs.createWriteStream(tempZipPath);
        await new Promise<void>((resolve, reject) => {
            response.data.pipe(writeStream);
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
            response.data.on('error', reject);
        });

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
            ? path.join(context.extractRoot, parentPath, finalFolderName)
            : path.join(context.extractRoot, finalFolderName);

        // Extract zip to target folder on disk
        await extractZipToFolder(tempZipPath, targetFolder);

        // Clean up temp zip file
        try {
            await fs.promises.unlink(tempZipPath);
        } catch (cleanupError) {
            logger.warn('Failed to cleanup temp zip file from URL', {
                tempZipPath,
                error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            });
        }

        context.successCount += 1;
        const relativeFolderName = parentPath
            ? path.posix.join(parentPath, finalFolderName)
            : finalFolderName;
        return { folderName: relativeFolderName, success: true };
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
        
        // Create folder on disk
        const diskFolderPath = path.join(context.extractRoot, folderPath);
        await fs.promises.mkdir(diskFolderPath, { recursive: true });

        if (Array.isArray(node.children) && node.children.length > 0) {
            const children = node.children as PackDownloadNode[];
            // Process concurrently since we're streaming to disk (no memory pressure)
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
        // Create failed folder on disk
        const diskFailedPath = path.join(context.extractRoot, failedPath);
        await fs.promises.mkdir(diskFailedPath, { recursive: true });
    }
}

async function generatePackDownloadZip(zipName: string, tree: PackDownloadNode, cacheKey: string): Promise<PackDownloadResponse> {
    await ensurePackDownloadDirs();
    await cleanupExpiredDownloads();

    const tempDir = path.join(PACK_DOWNLOAD_TEMP_DIR, crypto.randomUUID());
    const extractRoot = path.join(tempDir, 'extract');
    await fs.promises.mkdir(extractRoot, { recursive: true });

    const context: PackGenerationContext = {
        tempDir,
        extractRoot,
        successCount: 0,
        totalLevels: 0
    };

    try {
        // Process all nodes and extract to disk
        await processPackNode(tree, '', context);

        const downloadId = crypto.randomUUID();
        // Use UUID for local file to avoid conflicts
        const localZipFilename = `${downloadId}.zip`;
        const targetPath = path.join(PACK_DOWNLOAD_DIR, localZipFilename);
        
        // Create sanitized filename for Spaces: UUID folder with formatted zip name
        const sanitizedZipNameForSpaces = sanitizePathSegment(zipName);
        const spacesZipFilename = `${sanitizedZipNameForSpaces}.zip`;
        const spacesKeyFilename = `${PACK_DOWNLOAD_SPACES_PREFIX}/${downloadId}/${spacesZipFilename}`;

        // Use 7z to create final zip from extracted folders
        const sevenZipPath = '7z';
        let cmd: string;
        
        if (isWindows) {
            // Windows: 7z a (add) command
            // -tzip: force zip format, -mx=0: no compression (faster), -mm=Copy: store only
            // -r: recurse subdirectories, *: match all files and folders
            cmd = `cd /d "${extractRoot}" && "${sevenZipPath}" a -tzip -mx=0 -mm=Copy -r "${targetPath}" *`;
        } else {
            // Linux: zip command with -r (recursive) and -0 (store only, no compression)
            cmd = `cd "${extractRoot}" && zip -r -0 "${targetPath}" .`;
        }

        try {
            await execAsync(cmd, {
                shell: isWindows ? 'cmd.exe' : '/bin/bash',
                maxBuffer: 1024 * 1024 * 100 // 100MB buffer
            });
        } catch (error) {
            logger.error('Failed to create zip using 7z/zip, falling back to AdmZip', {
                error: error instanceof Error ? error.message : String(error),
                extractRoot,
                targetPath
            });
            // Fallback to AdmZip if 7z/zip fails
            const packZip = new AdmZip();
            await addDirectoryToZipRecursive(packZip, extractRoot, '');
            packZip.writeZip(targetPath);
        }

        let spacesKey: string | null = null;
        let responseUrl: string;
        try {
            await spacesStorage.uploadFile(targetPath, spacesKeyFilename, 'application/zip', {
                cacheKey,
                generatedAt: new Date().toISOString(),
                successLevels: context.successCount.toString(),
                totalLevels: context.totalLevels.toString()
            });
            spacesKey = spacesKeyFilename;
        } catch (error) {
            logger.error('Failed to upload pack download to Spaces', {
                error: error instanceof Error ? error.message : String(error),
                spacesKeyFilename,
                cacheKey
            });
        }

        if (spacesKey) {
            const presignedUrl = await spacesStorage.getPresignedUrl(
                spacesKey,
                Math.max(60, Math.floor(PACK_DOWNLOAD_TTL_MS / 1000))
            );
            responseUrl = presignedUrl;
        } else {
            responseUrl = `${CDN_CONFIG.baseUrl}/zips/packs/downloads/${downloadId}`;
        }

        if (spacesKey) {
            try {
                await fs.promises.rm(targetPath, { force: true });
            } catch (error) {
                logger.warn('Failed to delete local pack download after Spaces upload', {
                    error: error instanceof Error ? error.message : String(error),
                    targetPath
                });
            }
        }

        const expiresAt = Date.now() + PACK_DOWNLOAD_TTL_MS;
        const response: PackDownloadResponse = {
            downloadId,
            url: responseUrl,
            expiresAt: new Date(expiresAt).toISOString(),
            zipName,
            cacheKey
        };

        packDownloadEntries.set(downloadId, {
            filePath: spacesKey ? undefined : targetPath,
            expiresAt,
            zipName,
            cacheKey,
            spacesKey
        });
        packCacheIndex.set(cacheKey, downloadId);

        logger.debug('Generated pack download zip', {
            downloadId,
            zipName,
            cacheKey,
            successLevels: context.successCount,
            totalLevels: context.totalLevels,
            expiresAt: response.expiresAt,
            filePath: spacesKey ? undefined : targetPath,
            spacesKey
        });

        return response;
    } finally {
        // Clean up temp directory with extracted files
        try {
            if (fs.existsSync(tempDir)) {
                await fs.promises.rm(tempDir, { recursive: true, force: true });
                logger.debug('Cleaned up temp directory for pack download', { tempDir });
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
        const { zipName, tree, cacheKey, packCode } = req.body ?? {};

        if (!zipName || typeof zipName !== 'string') {
            return res.status(400).json({ error: 'zipName is required' });
        }
        if (!tree || !isPackDownloadNode(tree)) {
            return res.status(400).json({ error: 'Valid download tree is required' });
        }

        // Format zip name with pack code if provided
        let finalZipName = zipName;
        if (packCode && typeof packCode === 'string' && packCode.trim().length > 0) {
            // Check if pack code is already in the name (to avoid duplication)
            if (!zipName.includes(` - ${packCode}`)) {
                finalZipName = `${zipName} - ${packCode}`;
            }
        }

        const normalizedCacheKey = typeof cacheKey === 'string' && cacheKey.length > 0
            ? cacheKey
            : crypto.createHash('sha256').update(JSON.stringify({ zipName: finalZipName, tree })).digest('hex');

        const existingDownloadId = packCacheIndex.get(normalizedCacheKey);
        if (existingDownloadId) {
            const entry = packDownloadEntries.get(existingDownloadId);
            if (entry && entry.expiresAt > Date.now()) {
                try {
                    let url: string | null = null;
                    if (entry.spacesKey) {
                        const secondsRemaining = Math.max(
                            60,
                            Math.floor((entry.expiresAt - Date.now()) / 1000)
                        );
                        url = await spacesStorage.getPresignedUrl(entry.spacesKey, secondsRemaining);
                    } else if (entry.filePath && fs.existsSync(entry.filePath)) {
                        url = `${CDN_CONFIG.baseUrl}/zips/packs/downloads/${existingDownloadId}`;
                    }

                    if (url) {
                        return res.json({
                            downloadId: existingDownloadId,
                            url,
                            expiresAt: new Date(entry.expiresAt).toISOString(),
                            zipName: entry.zipName,
                            cacheKey: entry.cacheKey
                        });
                    }
                } catch (error) {
                    logger.error('Failed to reuse existing pack download cache entry:', {
                        cacheKey: normalizedCacheKey,
                        downloadId: existingDownloadId,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
            }
            packCacheIndex.delete(normalizedCacheKey);
            const staleEntry = packDownloadEntries.get(existingDownloadId);
            if (staleEntry) {
                if (staleEntry.spacesKey) {
                    spacesStorage.deleteFile(staleEntry.spacesKey).catch((error) => {
                        logger.warn('Failed to delete stale pack download from Spaces', {
                            downloadId: existingDownloadId,
                            spacesKey: staleEntry.spacesKey,
                            error: error instanceof Error ? error.message : String(error)
                        });
                    });
                }
                if (staleEntry.filePath && fs.existsSync(staleEntry.filePath)) {
                    fs.promises.rm(staleEntry.filePath, { force: true }).catch(() => undefined);
                }
            }
            packDownloadEntries.delete(existingDownloadId);
        }

        if (!packGenerationPromises.has(normalizedCacheKey)) {
            const sanitizedZipName = sanitizePathSegment(finalZipName);
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
            if (entry.filePath && fs.existsSync(entry.filePath)) {
                await fs.promises.rm(entry.filePath, { force: true });
            }
            packDownloadEntries.delete(id);
            if (packCacheIndex.get(entry.cacheKey) === id) {
                packCacheIndex.delete(entry.cacheKey);
            }
            return res.status(404).json({ error: 'Download expired' });
        }

        if (entry.spacesKey) {
            try {
                const secondsRemaining = Math.max(
                    60,
                    Math.floor((entry.expiresAt - Date.now()) / 1000)
                );
                const presignedUrl = await spacesStorage.getPresignedUrl(entry.spacesKey, secondsRemaining);
                return res.redirect(presignedUrl);
            } catch (error) {
                logger.error('Failed to get pack download presigned URL', {
                    downloadId: id,
                    spacesKey: entry.spacesKey,
                    error: error instanceof Error ? error.message : String(error)
                });
                return res.status(500).json({ error: 'Failed to serve download' });
            }
        }

        if (!entry.filePath || !fs.existsSync(entry.filePath)) {
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
