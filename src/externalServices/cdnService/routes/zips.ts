import path from 'path';
import fs from 'fs';
import AdmZip from 'adm-zip';
import axios from 'axios';
import { logger } from '../../../server/services/LoggerService.js';
import { storageManager } from '../services/storageManager.js';
import { CDN_CONFIG } from '../config.js';
import { processZipFile } from '../services/zipProcessor.js';
import { Request, Response, Router } from 'express';
import CdnFile from '../../../models/cdn/CdnFile.js';
import crypto from 'crypto';
import LevelDict from 'adofai-lib';
import sequelize from '../../../config/db.js';
import { Transaction } from 'sequelize';
import { safeTransactionRollback } from '../../../utils/Utility.js';
import { levelCacheService } from '../services/levelCacheService.js';
import { hybridStorageManager, StorageType } from '../services/hybridStorageManager.js';
import { spacesStorage } from '../services/spacesStorage.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const router = Router();

const execAsync = promisify(exec);
const isWindows = process.platform === 'win32';

const PACK_DOWNLOAD_DIR = path.join(CDN_CONFIG.pack_root, 'pack-downloads');
const PACK_DOWNLOAD_TEMP_DIR = path.join(PACK_DOWNLOAD_DIR, 'temp');
const PACK_DOWNLOAD_TTL_MS = 60 * 60 * 1000; // 1 hour
const PACK_DOWNLOAD_CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const PACK_DOWNLOAD_SPACES_PREFIX = process.env.NODE_ENV === 'development' ? 'pack-downloads-dev' : 'pack-downloads';
const PACK_DOWNLOAD_MAX_SIZE_BYTES = 15 * 1024 * 1024 * 1024; // 25GB hard limit
const PACK_DOWNLOAD_MAX_CONCURRENT_SIZE_BYTES = 20 * 1024 * 1024 * 1024; // 30GB total concurrent limit

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

// Progress tracking
interface PackDownloadProgress {
    downloadId: string;
    cacheKey: string;
    status: 'pending' | 'processing' | 'zipping' | 'uploading' | 'completed' | 'failed';
    totalLevels: number;
    processedLevels: number;
    currentLevel?: string;
    startedAt: number;
    lastUpdated: number;
    error?: string;
}

const packDownloadProgress = new Map<string, PackDownloadProgress>();

// Queue system for managing concurrent pack generations
interface ActiveGeneration {
    cacheKey: string;
    estimatedSize: number;
}

interface QueuedGeneration {
    cacheKey: string;
    estimatedSize: number;
    resolve: () => void;
    reject: (error: Error) => void;
}

const activeGenerations = new Map<string, ActiveGeneration>();
const generationQueue: QueuedGeneration[] = [];

function getTotalActiveSize(): number {
    let total = 0;
    for (const gen of activeGenerations.values()) {
        total += gen.estimatedSize;
    }
    return total;
}

async function waitForSpace(estimatedSize: number, cacheKey: string): Promise<void> {
    // If already registered (e.g., another request for same cacheKey is already active), skip
    if (activeGenerations.has(cacheKey)) {
        return;
    }
    
    const currentTotal = getTotalActiveSize();
    
    // If adding this request would exceed the limit, queue it
    if (currentTotal + estimatedSize > PACK_DOWNLOAD_MAX_CONCURRENT_SIZE_BYTES) {
        logger.debug('Pack generation queued due to size limit', {
            cacheKey,
            estimatedSize,
            estimatedSizeGB: (estimatedSize / (1024 * 1024 * 1024)).toFixed(2),
            currentTotal,
            currentTotalGB: (currentTotal / (1024 * 1024 * 1024)).toFixed(2),
            queueLength: generationQueue.length
        });
        
        // Wait in queue until space is available
        return new Promise<void>((resolve, reject) => {
            generationQueue.push({
                cacheKey,
                estimatedSize,
                resolve,
                reject
            });
        });
    }
    
    // Space available, register immediately
    activeGenerations.set(cacheKey, {
        cacheKey,
        estimatedSize
    });
    
    logger.debug('Pack generation started immediately', {
        cacheKey,
        estimatedSize,
        estimatedSizeGB: (estimatedSize / (1024 * 1024 * 1024)).toFixed(2),
        currentTotal: currentTotal + estimatedSize,
        currentTotalGB: ((currentTotal + estimatedSize) / (1024 * 1024 * 1024)).toFixed(2)
    });
}

function unregisterGeneration(cacheKey: string): void {
    const removed = activeGenerations.delete(cacheKey);
    if (!removed) {
        return;
    }
    
    logger.debug('Pack generation completed, processing queue', {
        cacheKey,
        currentTotal: getTotalActiveSize(),
        currentTotalGB: (getTotalActiveSize() / (1024 * 1024 * 1024)).toFixed(2),
        queueLength: generationQueue.length
    });
    
    // Process queue - try to start queued generations that can fit
    while (generationQueue.length > 0) {
        const queued = generationQueue[0];
        
        // Skip if this cacheKey is already registered (e.g., another request already started)
        if (activeGenerations.has(queued.cacheKey)) {
            generationQueue.shift(); // Remove from queue
            queued.resolve(); // Still resolve to unblock the waiting request
            continue;
        }
        
        // Recalculate current total (may have changed from previous iterations)
        const currentTotal = getTotalActiveSize();
        
        // Check if this queued item can fit now
        if (currentTotal + queued.estimatedSize <= PACK_DOWNLOAD_MAX_CONCURRENT_SIZE_BYTES) {
            generationQueue.shift(); // Remove from queue
            activeGenerations.set(queued.cacheKey, {
                cacheKey: queued.cacheKey,
                estimatedSize: queued.estimatedSize
            });
            
            logger.debug('Pack generation dequeued and started', {
                cacheKey: queued.cacheKey,
                estimatedSize: queued.estimatedSize,
                estimatedSizeGB: (queued.estimatedSize / (1024 * 1024 * 1024)).toFixed(2),
                newTotal: currentTotal + queued.estimatedSize,
                newTotalGB: ((currentTotal + queued.estimatedSize) / (1024 * 1024 * 1024)).toFixed(2),
                remainingQueueLength: generationQueue.length
            });
            
            queued.resolve();
        } else {
            // Can't fit this one yet, stop processing queue
            break;
        }
    }
}

// Get main server URL for progress callbacks
function getMainServerUrl(): string {
    if (process.env.NODE_ENV === 'production') {
        return process.env.PROD_API_URL || 'http://localhost:3000';
    } else if (process.env.NODE_ENV === 'staging') {
        return process.env.STAGING_API_URL || 'http://localhost:3000';
    } else {
        return process.env.DEV_URL || 'http://localhost:3002';
    }
}

// Update progress and send to main server
async function updateProgress(
    downloadId: string,
    cacheKey: string,
    updates: Partial<Omit<PackDownloadProgress, 'downloadId' | 'cacheKey' | 'startedAt' | 'lastUpdated'>>
): Promise<void> {
    const existing = packDownloadProgress.get(downloadId);
    if (!existing) {
        return; // Progress not initialized yet
    }

    const updated: PackDownloadProgress = {
        ...existing,
        ...updates,
        lastUpdated: Date.now()
    };

    packDownloadProgress.set(downloadId, updated);

    // Send update to main server
    await sendProgressUpdate(updated);
}

// Send progress update to main server
async function sendProgressUpdate(progress: PackDownloadProgress): Promise<void> {
    const mainServerUrl = getMainServerUrl();
    const progressPercent = progress.totalLevels > 0
        ? Math.round((progress.processedLevels / progress.totalLevels) * 100)
        : 0;

    const payload = {
        downloadId: progress.downloadId,
        cacheKey: progress.cacheKey,
        status: progress.status,
        totalLevels: progress.totalLevels,
        processedLevels: progress.processedLevels,
        currentLevel: progress.currentLevel,
        progressPercent,
        error: progress.error
    };

    try {
        await axios.post(`${mainServerUrl}/v2/cdn/pack-progress`, payload, {
            timeout: 5000 // 5 second timeout for progress updates
        });
    } catch (error) {
        // Log error but don't fail the generation - progress is best-effort
        logger.debug('Failed to send progress update to main server', {
            downloadId: progress.downloadId,
            error: error instanceof Error ? error.message : String(error)
        });
    }
}

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
    downloadId: string;
    cacheKey: string;
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
        const cleanupOnError = async (error: Error) => {
            stream.destroy();
            writeStream.destroy();
            // Clean up partial file on error
            try {
                if (fs.existsSync(targetPath)) {
                    await fs.promises.unlink(targetPath);
                }
            } catch (cleanupError) {
                logger.warn('Failed to cleanup partial file after stream error', {
                    targetPath,
                    error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
                });
            }
            reject(error);
        };

        stream.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', cleanupOnError);
        stream.on('error', cleanupOnError);
    });
}

async function extractZipToFolder(zipPath: string, extractTo: string): Promise<void> {
    await fs.promises.mkdir(extractTo, { recursive: true });
    
    const sevenZipPath = '7z';
    let cmd: string;
    
    if (isWindows) {
        // 7z: -mcu=on forces UTF-8 encoding for filenames
        cmd = `"${sevenZipPath}" x "${zipPath}" -o"${extractTo}" -y -mcu=on`;
    } else {
        // unzip: Use LC_ALL=C.UTF-8 to force UTF-8 locale (see https://ianwwagner.com/unzip-utf-8-docker-and-c-locales.html)
        // unzip checks locale via setlocale(LC_CTYPE, "") and needs explicit UTF-8 locale
        // -q: quiet mode (suppress most output)
        // Note: unzip may exit with code 1 for warnings but still extract successfully
        cmd = `unzip -o -q "${zipPath}" -d "${extractTo}"`;
    }
    
    try {
        await execAsync(cmd, {
            shell: isWindows ? 'cmd.exe' : '/bin/bash',
            maxBuffer: 1024 * 1024 * 100, // 100MB buffer for stdout/stderr
            // Set LC_ALL to force UTF-8 locale for unzip (overrides all locale categories)
            env: isWindows ? undefined : { ...process.env, LC_ALL: 'C.UTF-8' }
        });
    } catch (error: any) {
        // unzip exit codes: 0=success, 1=warnings but continued, 2=corrupt, 3=severe error
        // Exit code 1 often means filename encoding warnings but extraction succeeded
        const exitCode = error?.code;
        
        // Check if extraction actually succeeded by verifying files/directories exist
        let extractedEntries: fs.Dirent[] = [];
        try {
            extractedEntries = await fs.promises.readdir(extractTo, { withFileTypes: true });
        } catch {
            // Directory doesn't exist or can't be read - extraction failed
        }
        
        // If we have files/directories, extraction succeeded despite warnings
        if (extractedEntries.length > 0) {
            return; // Success - files were extracted
        }
        
        // Exit code 2 or 3 means real failure, or exit code 1 with no files extracted
        // Fall back to AdmZip
        logger.debug('Failed to extract zip using 7z/unzip, falling back to AdmZip', {
            zipPath,
            extractTo,
            error: error instanceof Error ? error.message : String(error),
            exitCode,
            stderr: error?.stderr?.substring(0, 500)
        });
        // Fallback to AdmZip if 7z/unzip fails
        // AdmZip reads zip entries directly and should preserve encoding
        const zip = new AdmZip(zipPath);
        // extractAllTo with overwrite=true should preserve UTF-8 filenames
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
        let tempZipPath: string | null = null;
        let finalFolderName: string;
        
        try {
            if (existence.storageType === StorageType.SPACES) {
                tempZipPath = path.join(context.tempDir, `level-${node.fileId}-${crypto.randomUUID()}.zip`);
                logger.debug('Creating temp zip file from Spaces', {
                    tempZipPath,
                    fileId: node.fileId,
                    sourcePath: originalZip.path
                });
                // Stream directly from Spaces to disk without loading into memory
                await streamSpacesFileToDisk(originalZip.path, tempZipPath);
                logger.debug('Successfully streamed zip file from Spaces to temp location', {
                    tempZipPath,
                    fileId: node.fileId,
                    fileExists: fs.existsSync(tempZipPath)
                });
                zipPath = tempZipPath;
            } else {
                zipPath = existence.actualPath;
                logger.debug('Using local zip file path (no temp file needed)', {
                    zipPath,
                    fileId: node.fileId
                });
            }

            const derivedName = originalZip.originalFilename || originalZip.name;
            const baseFolderName = derivedName
                ? path.parse(derivedName).name
                : node.name || `Level-${node.levelId ?? 'unknown'}`;
            finalFolderName = buildLevelFolderName(node, baseFolderName);
            const targetFolder = parentPath
                ? path.join(context.extractRoot, parentPath, finalFolderName)
                : path.join(context.extractRoot, finalFolderName);

            // Extract zip to target folder on disk
            await extractZipToFolder(zipPath, targetFolder);

            // Delete temp zip file immediately after successful extraction to free up space
            // Only delete if it's a temp file we created (from Spaces), not the original source file
            if (tempZipPath && existence.storageType === StorageType.SPACES) {
                const fileExists = fs.existsSync(tempZipPath);
                logger.debug('Attempting to delete temp zip file after extraction', {
                    tempZipPath,
                    fileExists,
                    storageType: existence.storageType,
                    fileId: node.fileId
                });
                
                if (fileExists) {
                    try {
                        await fs.promises.unlink(tempZipPath);
                        logger.debug('Successfully deleted temp zip file after extraction', {
                            tempZipPath,
                            fileId: node.fileId
                        });
                        tempZipPath = null; // Mark as cleaned up to avoid double deletion
                    } catch (cleanupError) {
                        logger.warn('Failed to cleanup temp zip file after extraction', {
                            tempZipPath,
                            fileId: node.fileId,
                            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                            errorStack: cleanupError instanceof Error ? cleanupError.stack : undefined
                        });
                    }
                } else {
                    logger.debug('Temp zip file does not exist, skipping deletion', {
                        tempZipPath,
                        fileId: node.fileId
                    });
                }
            } else {
                logger.debug('Skipping temp zip deletion (not a temp file)', {
                    tempZipPath,
                    storageType: existence.storageType,
                    actualPath: existence.actualPath,
                    fileId: node.fileId
                });
            }

            context.successCount += 1;
            const relativeFolderName = parentPath
                ? path.posix.join(parentPath, finalFolderName)
                : finalFolderName;
            
            // Update progress after successful level extraction
            await updateProgress(context.downloadId, context.cacheKey, {
                processedLevels: context.successCount,
                currentLevel: finalFolderName
            });
            
            return { folderName: relativeFolderName, success: true };
        } finally {
            // Clean up temp zip file if extraction failed (fallback cleanup)
            // Only delete if it's a temp file we created (from Spaces)
            if (tempZipPath && existence && existence.storageType === StorageType.SPACES) {
                const fileExists = fs.existsSync(tempZipPath);
                logger.debug('Finally block: checking temp zip file for cleanup', {
                    tempZipPath,
                    fileExists,
                    fileId: node.fileId
                });
                
                if (fileExists) {
                    try {
                        await fs.promises.unlink(tempZipPath);
                        logger.debug('Successfully deleted temp zip file in finally block', {
                            tempZipPath,
                            fileId: node.fileId
                        });
                    } catch (cleanupError) {
                        logger.warn('Failed to cleanup temp zip file in finally block', {
                            tempZipPath,
                            fileId: node.fileId,
                            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                            errorStack: cleanupError instanceof Error ? cleanupError.stack : undefined
                        });
                    }
                }
            } else if (tempZipPath) {
                logger.debug('Finally block: skipping temp zip deletion', {
                    tempZipPath,
                    hasExistence: !!existence,
                    storageType: existence?.storageType,
                    fileId: node.fileId
                });
            }
        }
    } catch (error) {
        logger.debug('Failed to add CDN level to pack download', {
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

    let tempZipPath: string | null = null;
    try {
        // Download zip to temp file
        tempZipPath = path.join(context.tempDir, `url-level-${crypto.randomUUID()}.zip`);
        logger.debug('Creating temp zip file from URL', {
            tempZipPath,
            sourceUrl: node.sourceUrl
        });
        const response = await axios.get(node.sourceUrl, {
            responseType: 'stream',
            timeout: 30_000 // Increased timeout for large files
        });

        const writeStream = fs.createWriteStream(tempZipPath);
        await new Promise<void>((resolve, reject) => {
            const cleanupOnError = async (error: Error) => {
                writeStream.destroy();
                // Clean up partial file on error
                try {
                    if (tempZipPath && fs.existsSync(tempZipPath)) {
                        await fs.promises.unlink(tempZipPath);
                    }
                } catch (cleanupError) {
                    logger.warn('Failed to cleanup partial download file', {
                        tempZipPath,
                        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
                    });
                }
                reject(error);
            };

            response.data.pipe(writeStream);
            writeStream.on('finish', () => {
                logger.debug('Successfully downloaded zip file from URL to temp location', {
                    tempZipPath,
                    sourceUrl: node.sourceUrl,
                    fileExists: tempZipPath ? fs.existsSync(tempZipPath) : false
                });
                resolve();
            });
            writeStream.on('error', cleanupOnError);
            response.data.on('error', cleanupOnError);
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

        // Delete temp zip file immediately after successful extraction to free up space
        const fileExists = fs.existsSync(tempZipPath);
        logger.debug('Attempting to delete temp zip file after extraction (from URL)', {
            tempZipPath,
            fileExists,
            sourceUrl: node.sourceUrl
        });
        
        if (fileExists) {
            try {
                await fs.promises.unlink(tempZipPath);
                logger.debug('Successfully deleted temp zip file after extraction (from URL)', {
                    tempZipPath,
                    sourceUrl: node.sourceUrl
                });
                tempZipPath = null; // Mark as cleaned up to avoid double deletion
            } catch (cleanupError) {
                logger.warn('Failed to cleanup temp zip file after extraction (from URL)', {
                    tempZipPath,
                    sourceUrl: node.sourceUrl,
                    error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                    errorStack: cleanupError instanceof Error ? cleanupError.stack : undefined
                });
            }
        } else {
            logger.debug('Temp zip file does not exist, skipping deletion (from URL)', {
                tempZipPath,
                sourceUrl: node.sourceUrl
            });
        }

        context.successCount += 1;
        const relativeFolderName = parentPath
            ? path.posix.join(parentPath, finalFolderName)
            : finalFolderName;
        
        // Update progress after successful level extraction
        await updateProgress(context.downloadId, context.cacheKey, {
            processedLevels: context.successCount,
            currentLevel: finalFolderName
        });
        
        return { folderName: relativeFolderName, success: true };
    } catch (error) {
        logger.debug('Failed to download external level for pack generation', {
            sourceUrl: node.sourceUrl,
            error: error instanceof Error ? error.message : String(error)
        });
        return { folderName: parentPath, success: false };
    } finally {
        // Clean up temp zip file if extraction failed (fallback cleanup)
        if (tempZipPath) {
            const fileExists = fs.existsSync(tempZipPath);
            logger.debug('Finally block: checking temp zip file for cleanup (from URL)', {
                tempZipPath,
                fileExists,
                sourceUrl: node.sourceUrl
            });
            
            if (fileExists) {
                try {
                    await fs.promises.unlink(tempZipPath);
                    logger.debug('Successfully deleted temp zip file in finally block (from URL)', {
                        tempZipPath,
                        sourceUrl: node.sourceUrl
                    });
                } catch (cleanupError) {
                    logger.warn('Failed to cleanup temp zip file from URL in finally block', {
                        tempZipPath,
                        sourceUrl: node.sourceUrl,
                        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                        errorStack: cleanupError instanceof Error ? cleanupError.stack : undefined
                    });
                }
            }
        }
    }
}

// Count total levels in tree
function countTotalLevels(node: PackDownloadNode): number {
    if (node.type === 'folder') {
        if (!Array.isArray(node.children)) {
            return 0;
        }
        return node.children.reduce((total, child) => total + countTotalLevels(child), 0);
    }
    return 1; // Level node
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

async function generatePackDownloadZip(
    zipName: string, 
    tree: PackDownloadNode, 
    cacheKey: string,
    clientDownloadId?: string // Client-provided downloadId for progress tracking
): Promise<PackDownloadResponse> {
    await ensurePackDownloadDirs();
    await cleanupExpiredDownloads();

    const tempDir = path.join(PACK_DOWNLOAD_TEMP_DIR, crypto.randomUUID());
    const extractRoot = path.join(tempDir, 'extract');
    await fs.promises.mkdir(extractRoot, { recursive: true });

    // Use client-provided downloadId if available, otherwise generate a new one
    const downloadId = clientDownloadId || crypto.randomUUID();
    
    // Count total levels before processing
    const totalLevels = countTotalLevels(tree);

    const context: PackGenerationContext = {
        tempDir,
        extractRoot,
        successCount: 0,
        totalLevels: 0, // Will be incremented during processing
        downloadId,
        cacheKey
    };

    // Initialize progress tracking
    const initialProgress: PackDownloadProgress = {
        downloadId,
        cacheKey,
        status: 'processing',
        totalLevels,
        processedLevels: 0,
        startedAt: Date.now(),
        lastUpdated: Date.now()
    };
    packDownloadProgress.set(downloadId, initialProgress);
    await sendProgressUpdate(initialProgress);

    let targetPath: string | null = null;

    try {
        // Process all nodes and extract to disk
        await processPackNode(tree, '', context);

        // Update progress: processing complete, now zipping
        await updateProgress(downloadId, cacheKey, {
            status: 'zipping'
        });
        // Use UUID for local file to avoid conflicts
        const localZipFilename = `${downloadId}.zip`;
        targetPath = path.join(PACK_DOWNLOAD_DIR, localZipFilename);
        
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
            // -mcu=on: force UTF-8 encoding for filenames
            cmd = `cd /d "${extractRoot}" && "${sevenZipPath}" a -tzip -mx=0 -mm=Copy -r -mcu=on "${targetPath}" *`;
        } else {
            // Linux: zip command with -r (recursive) and -0 (store only, no compression)
            // Use LC_ALL=C.UTF-8 to ensure UTF-8 encoding for filenames
            cmd = `cd "${extractRoot}" && zip -r -0 "${targetPath}" .`;
        }

        try {
            await execAsync(cmd, {
                shell: isWindows ? 'cmd.exe' : '/bin/bash',
                maxBuffer: 1024 * 1024 * 100, // 100MB buffer
                // Set LC_ALL to force UTF-8 locale (overrides all locale categories)
                env: isWindows ? undefined : { ...process.env, LC_ALL: 'C.UTF-8' }
            });
        } catch (error) {
            logger.error('Failed to create zip using 7z/zip', {
                error: error instanceof Error ? error.message : String(error),
                extractRoot,
                targetPath
            });
            throw error;
        }

        let spacesKey: string | null = null;
        let responseUrl: string;
        
        // Update progress: uploading if using Spaces
        if (spacesKeyFilename) {
            await updateProgress(downloadId, cacheKey, {
                status: 'uploading'
            });
        }
        
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

        // Update progress: completed
        await updateProgress(downloadId, cacheKey, {
            status: 'completed',
            processedLevels: context.successCount
        });

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
    } catch (error) {
        // Update progress: failed
        if (downloadId) {
            await updateProgress(downloadId, cacheKey, {
                status: 'failed',
                error: error instanceof Error ? error.message : String(error)
            });
        }
        
        // Clean up targetPath if it was created but upload failed
        if (targetPath && fs.existsSync(targetPath)) {
            try {
                await fs.promises.rm(targetPath, { force: true });
                logger.debug('Cleaned up failed pack download zip file', { targetPath });
            } catch (cleanupError) {
                logger.warn('Failed to cleanup failed pack download zip file', {
                    targetPath,
                    error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
                });
            }
        }
        throw error;
    } finally {
        // Clean up temp directory with extracted files (always)
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

async function getFileSizeFromCdn(fileId: string): Promise<number | null> {
    try {
        const cdnFile = await CdnFile.findByPk(fileId);
        if (!cdnFile || cdnFile.type !== 'LEVELZIP' || !cdnFile.metadata) {
            return null;
        }

        const metadata = cdnFile.metadata as any;
        const originalZip = metadata.originalZip;
        if (!originalZip?.path) {
            return null;
        }

        // Try to get size from metadata first
        if (typeof originalZip.size === 'number' && originalZip.size > 0) {
            return originalZip.size;
        }

        // If not in metadata, try to get from file system/storage
        const preferredStorage = originalZip.storageType || metadata.storageType || StorageType.LOCAL;
        const existence = await hybridStorageManager.fileExistsWithFallback(originalZip.path, preferredStorage);
        
        if (!existence.exists) {
            return null;
        }

        // Try to get file size from local file system
        if (existence.storageType === StorageType.LOCAL && existence.actualPath) {
            try {
                const stats = await fs.promises.stat(existence.actualPath);
                return stats.size;
            } catch {
                return null;
            }
        }

        // For Spaces, try to get size from S3 metadata
        if (existence.storageType === StorageType.SPACES) {
            try {
                const s3 = (spacesStorage as any).s3;
                const bucket = (spacesStorage as any).config?.bucket;
                if (s3 && bucket) {
                    const headResult = await s3.headObject({
                        Bucket: bucket,
                        Key: originalZip.path
                    }).promise();
                    if (headResult.ContentLength) {
                        return headResult.ContentLength;
                    }
                }
            } catch {
                // If we can't get size from Spaces, return null
                return null;
            }
        }

        return null;
    } catch (error) {
        logger.debug('Failed to get file size from CDN', {
            fileId,
            error: error instanceof Error ? error.message : String(error)
        });
        return null;
    }
}

async function getFileSizeFromUrl(sourceUrl: string): Promise<number | null> {
    try {
        const response = await axios.head(sourceUrl, {
            timeout: 10000,
            maxRedirects: 5,
            validateStatus: (status) => status >= 200 && status < 400
        });
        
        const contentLength = response.headers['content-length'];
        if (contentLength) {
            const size = parseInt(contentLength, 10);
            if (!isNaN(size) && size > 0) {
                return size;
            }
        }
        return null;
    } catch (error) {
        logger.debug('Failed to get file size from URL', {
            sourceUrl,
            error: error instanceof Error ? error.message : String(error)
        });
        return null;
    }
}

async function estimateTotalZipSize(tree: PackDownloadNode): Promise<{ totalSize: number; estimatedCount: number; failedCount: number }> {
    let totalSize = 0;
    let estimatedCount = 0;
    let failedCount = 0;

    async function traverseNode(node: PackDownloadNode): Promise<void> {
        if (node.type === 'folder') {
            if (Array.isArray(node.children)) {
                await Promise.all(node.children.map(child => traverseNode(child)));
            }
            return;
        }

        // For level nodes, estimate size
        if (node.type === 'level') {
            estimatedCount++;
            let size: number | null = null;

            if (node.fileId) {
                size = await getFileSizeFromCdn(node.fileId);
            } else if (node.sourceUrl) {
                size = await getFileSizeFromUrl(node.sourceUrl);
            }

            if (size !== null && size > 0) {
                totalSize += size;
            } else {
                failedCount++;
                // If we can't determine size, use a conservative estimate of 50MB per level
                // This ensures we don't allow unlimited growth if size detection fails
                totalSize += 50 * 1024 * 1024; // 50MB estimate
            }
        }
    }

    await traverseNode(tree);
    return { totalSize, estimatedCount, failedCount };
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
        const { zipName, tree, cacheKey, packCode, downloadId: clientDownloadId } = req.body ?? {};

        if (!zipName || typeof zipName !== 'string') {
            return res.status(400).json({ error: 'zipName is required' });
        }
        if (!tree || !isPackDownloadNode(tree)) {
            return res.status(400).json({ error: 'Valid download tree is required' });
        }

        // Estimate total zip size before generation
        logger.debug('Estimating total zip size for pack download', { zipName });
        const sizeEstimate = await estimateTotalZipSize(tree);
        
        if (sizeEstimate.totalSize > PACK_DOWNLOAD_MAX_SIZE_BYTES) {
            const sizeGB = (sizeEstimate.totalSize / (1024 * 1024 * 1024)).toFixed(2);
            const maxGB = (PACK_DOWNLOAD_MAX_SIZE_BYTES / (1024 * 1024 * 1024)).toFixed(0);
            logger.debug('Pack download size exceeds limit', {
                estimatedSize: sizeEstimate.totalSize,
                estimatedSizeGB: sizeGB,
                maxSizeGB: maxGB,
                estimatedCount: sizeEstimate.estimatedCount,
                failedCount: sizeEstimate.failedCount
            });
            return res.status(400).json({
                error: `Pack download size exceeds maximum limit of ${maxGB}GB`,
                estimatedSize: sizeEstimate.totalSize,
                estimatedSizeGB: sizeGB,
                maxSizeGB: maxGB,
                code: 'PACK_SIZE_LIMIT_EXCEEDED'
            });
        }

        logger.debug('Pack download size estimate within limits', {
            estimatedSize: sizeEstimate.totalSize,
            estimatedSizeGB: (sizeEstimate.totalSize / (1024 * 1024 * 1024)).toFixed(2),
            estimatedCount: sizeEstimate.estimatedCount,
            failedCount: sizeEstimate.failedCount
        });

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
                        // Send completed progress event for cached download
                        // This ensures frontend receives the completion status via WebSocket
                        const cachedProgress: PackDownloadProgress = {
                            downloadId: existingDownloadId,
                            cacheKey: entry.cacheKey,
                            status: 'completed',
                            totalLevels: 0, // Unknown for cached, but status is what matters
                            processedLevels: 0,
                            startedAt: Date.now() - (entry.expiresAt - Date.now()), // Approximate
                            lastUpdated: Date.now()
                        };
                        // Send progress update asynchronously (don't wait)
                        sendProgressUpdate(cachedProgress).catch(error => {
                            logger.debug('Failed to send cached download progress update', {
                                downloadId: existingDownloadId,
                                error: error instanceof Error ? error.message : String(error)
                            });
                        });
                        
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
            // Wait for space in the queue system before starting generation
            // This will register the generation if space is available, or queue it if not
            await waitForSpace(sizeEstimate.totalSize, normalizedCacheKey);
            
            const sanitizedZipName = sanitizePathSegment(finalZipName);
            const generationPromise = (async () => {
                try {
                    return await generatePackDownloadZip(sanitizedZipName, tree, normalizedCacheKey, clientDownloadId);
                } catch (error) {
                    // If generation fails, still unregister to free up space
                    throw error;
                } finally {
                    // Unregister from active generations and process queue
                    unregisterGeneration(normalizedCacheKey);
                    packGenerationPromises.delete(normalizedCacheKey);
                }
            })();

            packGenerationPromises.set(normalizedCacheKey, generationPromise);
        } else {
            // Generation already in progress for this cacheKey
            // It's already registered, so we just await the existing promise
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

// Send level upload progress update to main server
async function sendLevelUploadProgress(
    uploadId: string | undefined,
    status: 'uploading' | 'processing' | 'caching' | 'completed' | 'failed',
    progressPercent: number,
    currentStep?: string,
    error?: string
): Promise<void> {
    if (!uploadId) {
        return; // No upload ID, skip progress update
    }

    const mainServerUrl = getMainServerUrl();
    const payload = {
        uploadId,
        status,
        progressPercent,
        currentStep,
        error
    };

    try {
        await axios.post(`${mainServerUrl}/v2/cdn/level-upload-progress`, payload, {
            timeout: 5000 // 5 second timeout for progress updates
        });
    } catch (error) {
        // Log but don't fail the upload if progress update fails
        logger.debug('Failed to send level upload progress update', {
            uploadId,
            error: error instanceof Error ? error.message : String(error)
        });
    }
}

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

        // Get upload ID from header
        const uploadId = req.headers['x-upload-id'] as string | undefined;

        try {
            // Generate a UUID for the database entry
            const fileId = crypto.randomUUID();
            logger.debug('Generated UUID for database entry:', { fileId });

            // Send initial progress
            await sendLevelUploadProgress(uploadId, 'uploading', 0, 'Uploading file to server');

            // Process zip file first to validate contents
            logger.debug('Starting zip file processing');
            
            // Create progress callback
            const onProgress = async (
                status: 'uploading' | 'processing' | 'caching' | 'completed' | 'failed',
                progressPercent: number,
                currentStep?: string
            ) => {
                await sendLevelUploadProgress(uploadId, status, progressPercent, currentStep);
            };

            await processZipFile(req.file.path, fileId, req.file.originalname, onProgress);
            logger.debug('Successfully processed zip file');

            // Clean up the original zip file since we've extracted what we need
            logger.debug('Cleaning up original zip file');
            storageManager.cleanupFiles(req.file.path);
            logger.debug('Original zip file cleaned up');

            // Populate cache for the uploaded level
            await sendLevelUploadProgress(uploadId, 'caching', 95, 'Populating cache');
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

            // Send completion progress
            await sendLevelUploadProgress(uploadId, 'completed', 100, 'Upload completed');

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

            // Send failure progress
            const uploadId = req.headers['x-upload-id'] as string | undefined;
            await sendLevelUploadProgress(
                uploadId,
                'failed',
                0,
                'Upload failed',
                error instanceof Error ? error.message : String(error)
            );

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
