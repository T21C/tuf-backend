import path from 'path';
import fs from 'fs';
import AdmZip from 'adm-zip';
import axios from 'axios';
import { emitCdnJobProgress } from '@/externalServices/cdnService/jobs/jobProgressIngest.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { CDN_CONFIG, CDN_IMMUTABLE_CACHE_CONTROL } from '@/externalServices/cdnService/config.js';
import { Request, Response, Router } from 'express';
import CdnFile from '@/models/cdn/CdnFile.js';
import crypto from 'crypto';
import { spacesStorage } from '@/externalServices/cdnService/infra/storage/spacesStorage.js';
import { LEVEL_SUPPORTED_AUDIO_EXTENSION_SET } from '@/externalServices/cdnService/constants/levelPackAudio.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const router = Router();

const execAsync = promisify(exec);
const isWindows = process.platform === 'win32';

const PACK_DOWNLOAD_DIR = path.join(CDN_CONFIG.pack_root, 'pack-downloads');
const PACK_DOWNLOAD_TEMP_DIR = path.join(PACK_DOWNLOAD_DIR, 'temp');
const PACK_DOWNLOAD_TTL_MS = 60 * 60 * 1000; // 1 hour
const PACK_DOWNLOAD_CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
/** Min interval between pack upload progress broadcasts (R2 multipart fires often). */
const PACK_UPLOAD_PROGRESS_THROTTLE_MS = 400;
const PACK_DOWNLOAD_SPACES_PREFIX = process.env.NODE_ENV === 'development' ? 'pack-downloads-dev' : 'pack-downloads';
const PACK_DOWNLOAD_MAX_SIZE_BYTES = 15 * 1024 * 1024 * 1024; // 15GB hard limit
const PACK_DOWNLOAD_MAX_CONCURRENT_SIZE_BYTES = 20 * 1024 * 1024 * 1024; // 20GB total concurrent limit
/** Max path length for extraction (e.g. Windows MAX_PATH 260; extract folder + sep + path inside zip). */
const MAX_PATH_LENGTH = 200;
/** Minimum characters kept when trimming a folder name or file stem (avoids single-character segments). */
const MIN_TRIMMED_SEGMENT_LEN = 7;
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
/** Main-API job ids that share one in-flight build for this cache key (fan-out + mid-flight join replay). */
const packGenerationJobSubscribers = new Map<string, Set<string>>();
/** `packDownloadProgress` map key for the worker (first request’s downloadId). */
const inFlightPackPrimaryJobId = new Map<string, string>();

// Progress tracking
interface PackDownloadProgress {
    downloadId: string;
    cacheKey: string;
    status: 'pending' | 'processing' | 'zipping' | 'uploading' | 'completed' | 'failed';
    totalLevels: number;
    processedLevels: number;
    currentLevel?: string;
    /** Populated during R2 upload for percent + meta.uploadBytes* */
    uploadLoaded?: number;
    uploadTotal?: number;
    startedAt: number;
    lastUpdated: number;
    error?: string;
    /** Set when status is completed — merged into main API job `meta` for the client download step. */
    packUrl?: string;
    packZipName?: string;
    packExpiresAt?: string;
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

function formatPackUploadBytes(loaded: number, total: number): string {
    const fmt = (n: number) =>
        n >= 1_000_000_000
            ? `${(n / 1_000_000_000).toFixed(2)} GB`
            : n >= 1_000_000
              ? `${(n / 1_000_000).toFixed(2)} MB`
              : n >= 1_000
                ? `${(n / 1_000).toFixed(1)} KB`
                : `${Math.round(n)} B`;
    if (!total || total <= 0) {
        return fmt(loaded);
    }
    const pct = Math.min(100, Math.round((loaded / total) * 100));
    return `${fmt(loaded)} / ${fmt(total)} (${pct}%)`;
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

    await broadcastPackJobProgress(updated);
}

/**
 * Single job ingest: POST /v2/cdn/job-progress with a specific `jobId` (may differ from `progress.downloadId`,
 * which is always the primary worker id used in `packDownloadProgress`).
 */
async function sendJobProgressIngest(targetJobId: string, progress: PackDownloadProgress): Promise<void> {
    await emitCdnJobProgress({variant: 'pack', targetJobId, progress});
}

/**
 * Replay the same progress snapshot to every subscriber job for this in-flight cache key.
 * When no subscriber set exists (e.g. cache-only path), sends once using `progress.downloadId`.
 */
async function broadcastPackJobProgress(progress: PackDownloadProgress): Promise<void> {
    const subs = packGenerationJobSubscribers.get(progress.cacheKey);
    const targets = subs && subs.size > 0 ? [...subs] : [progress.downloadId];
    await Promise.all(targets.map((jobId) => sendJobProgressIngest(jobId, progress)));
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
    const withId = node.levelId !== null
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
    await spacesStorage.downloadFileToPathStreaming(spacesKey, targetPath);
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

        const storedPath = String(originalZip.path);
        const localCandidate = path.resolve(storedPath);
        const isProbablyLocal = fs.existsSync(localCandidate);

        // Stream zip to temp file if from Spaces, otherwise use local path
        let zipPath: string;
        let tempZipPath: string | null = null;
        let finalFolderName: string;

        try {
            if (isProbablyLocal) {
                zipPath = localCandidate;
                logger.debug('Using local original archive path for pack download', {
                    zipPath,
                    fileId: node.fileId
                });
            } else {
                const existsInSpaces = await spacesStorage.fileExists(storedPath);
                if (!existsInSpaces) {
                    logger.warn('Original zip not found in object storage for pack download', {
                        fileId: node.fileId,
                        key: storedPath
                    });
                    return { folderName: parentPath, success: false };
                }

                tempZipPath = path.join(context.tempDir, `level-${node.fileId}-${crypto.randomUUID()}.zip`);
                logger.debug('Creating temp zip file from object storage', {
                    tempZipPath,
                    fileId: node.fileId,
                    sourceKey: storedPath
                });
                await streamSpacesFileToDisk(storedPath, tempZipPath);
                logger.debug('Successfully streamed zip file from object storage to temp location', {
                    tempZipPath,
                    fileId: node.fileId,
                    fileExists: fs.existsSync(tempZipPath)
                });
                zipPath = tempZipPath;
            }

            const derivedFromZip = originalZip.originalFilename || originalZip.name;
            const zipBaseName = derivedFromZip ? path.parse(derivedFromZip).name : null;
            const baseFolderName = node.name || zipBaseName || `Level-${node.levelId ?? 'unknown'}`;
            finalFolderName = buildLevelFolderName(node, baseFolderName);
            const targetFolder = parentPath
                ? path.join(context.extractRoot, parentPath, finalFolderName)
                : path.join(context.extractRoot, finalFolderName);

            // Extract zip to target folder on disk
            await extractZipToFolder(zipPath, targetFolder);

            // Delete temp zip file immediately after successful extraction to free up space
            // Only delete if it's a temp file we created (from Spaces), not the original source file
            if (tempZipPath) {
                const fileExists = fs.existsSync(tempZipPath);
                logger.debug('Attempting to delete temp zip file after extraction', {
                    tempZipPath,
                    fileExists,
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
            if (tempZipPath) {
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

        const fromUrl = dispositionFilename || urlFilename;
        const urlBaseName = fromUrl ? path.parse(fromUrl).name || fromUrl : null;
        const isGenericName = (s: string) =>
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ||
            /^(download|level|file|zip)$/i.test(s);
        const rawName = (urlBaseName && !isGenericName(urlBaseName)) ? fromUrl! : defaultName;
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

const PATH_SEP = path.win32.sep;

type TrimmableSegmentKind = 'folder' | 'file';

/** Compute path length with trimmable segments capped at maxSegLen (folders: full basename; files: stem only, ext preserved). */
function pathLengthWithCap(relPath: string, trimmableKinds: Map<string, TrimmableSegmentKind>, maxSegLen: number): number {
    const norm = path.win32.normalize(relPath);
    const segments = norm.split(PATH_SEP);
    let acc = '';
    let len = 0;
    for (const seg of segments) {
        acc = acc ? `${acc}${PATH_SEP}${seg}` : seg;
        const kind = trimmableKinds.get(acc);
        let segLen: number;
        if (kind === 'folder') {
            segLen = Math.min(seg.length, maxSegLen);
        } else if (kind === 'file') {
            const parsed = path.parse(seg);
            segLen = Math.min(parsed.name.length, maxSegLen) + parsed.ext.length;
        } else {
            segLen = seg.length;
        }
        len += (len > 0 ? 1 : 0) + segLen;
    }
    return len;
}

/** Returns max relative path length over all paths, and the path that achieved it. */
async function getMaxRelativePathAndLength(dir: string, root: string): Promise<{ maxLen: number; maxPath: string }> {
    let maxLen = 0;
    let maxPath = '';
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
        const fullPath = path.join(dir, e.name);
        const rel = path.relative(root, fullPath);
        const relNormalized = path.win32.normalize(rel);
        if (relNormalized.length > maxLen) {
            maxLen = relNormalized.length;
            maxPath = relNormalized;
        }
        if (e.isDirectory()) {
            const sub = await getMaxRelativePathAndLength(fullPath, root);
            if (sub.maxLen > maxLen) {
                maxLen = sub.maxLen;
                maxPath = sub.maxPath;
            }
        }
    }
    return { maxLen, maxPath };
}

/** Returns max path length when all marked trimmable segments are capped at maxSegLen. */
async function getMaxPathLengthWithCap(
    dir: string,
    root: string,
    trimmableKinds: Map<string, TrimmableSegmentKind>,
    maxSegLen: number
): Promise<number> {
    let maxLen = 0;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
        const fullPath = path.join(dir, e.name);
        const rel = path.relative(root, fullPath);
        const relNorm = path.win32.normalize(rel);
        const len = pathLengthWithCap(relNorm, trimmableKinds, maxSegLen);
        if (len > maxLen) maxLen = len;
        if (e.isDirectory()) {
            const subMax = await getMaxPathLengthWithCap(fullPath, root, trimmableKinds, maxSegLen);
            if (subMax > maxLen) maxLen = subMax;
        }
    }
    return maxLen;
}

interface FolderInfo {
    relativePath: string;
    name: string;
    isPureFolderOfFolders: boolean;
}

interface TrimmablePayloadFile {
    relativePath: string;
    name: string;
    stem: string;
    ext: string;
}

function buildTrimmableKindsMap(folders: FolderInfo[], files: TrimmablePayloadFile[]): Map<string, TrimmableSegmentKind> {
    const m = new Map<string, TrimmableSegmentKind>();
    for (const f of folders) {
        m.set(path.win32.normalize(f.relativePath), 'folder');
    }
    for (const f of files) {
        m.set(path.win32.normalize(f.relativePath), 'file');
    }
    return m;
}

async function findBestSegmentCap(
    extractRoot: string,
    trimmableKinds: Map<string, TrimmableSegmentKind>,
    pathBudget: number,
    maxSegCandidate: number
): Promise<number> {
    let low = MIN_TRIMMED_SEGMENT_LEN;
    let high = Math.max(maxSegCandidate, MIN_TRIMMED_SEGMENT_LEN);
    let bestCap = MIN_TRIMMED_SEGMENT_LEN;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const simulatedMax = await getMaxPathLengthWithCap(extractRoot, extractRoot, trimmableKinds, mid);
        if (simulatedMax <= pathBudget) {
            bestCap = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return Math.max(bestCap, MIN_TRIMMED_SEGMENT_LEN);
}

/** `.adofai` and known audio files — safe to shorten stems for path limits (user can re-pick audio in editor). */
async function collectTrimmablePayloadFiles(dir: string, root: string): Promise<TrimmablePayloadFile[]> {
    const result: TrimmablePayloadFile[] = [];
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
        const fullPath = path.join(dir, e.name);
        if (e.isDirectory()) {
            result.push(...(await collectTrimmablePayloadFiles(fullPath, root)));
            continue;
        }
        const extLower = path.extname(e.name).toLowerCase();
        const isAdofai = extLower === '.adofai';
        const isAudio = LEVEL_SUPPORTED_AUDIO_EXTENSION_SET.has(extLower);
        if (!isAdofai && !isAudio) {
            continue;
        }
        const rel = path.relative(root, fullPath);
        const parsed = path.parse(e.name);
        result.push({
            relativePath: rel,
            name: e.name,
            stem: parsed.name,
            ext: parsed.ext
        });
    }
    return result;
}

/** Recursively collect all folders; marks which are pure folders-of-folders (no files). */
async function collectFolders(dir: string, root: string): Promise<FolderInfo[]> {
    const result: FolderInfo[] = [];
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const rel = path.relative(root, dir);
    const isPureFolderOfFolders = entries.length > 0 && entries.every((e) => e.isDirectory());

    if (rel && rel !== '.') {
        result.push({
            relativePath: rel,
            name: path.basename(dir),
            isPureFolderOfFolders: isPureFolderOfFolders
        });
    }

    for (const e of entries) {
        if (e.isDirectory()) {
            const sub = await collectFolders(path.join(dir, e.name), root);
            result.push(...sub);
        }
    }
    return result;
}

async function applyPackPathRenames(
    extractRoot: string,
    folderRenameList: FolderInfo[],
    trimmableFiles: TrimmablePayloadFile[],
    bestCap: number
): Promise<void> {
    type RenameEntry =
        | { kind: 'folder'; relativePath: string; name: string }
        | { kind: 'file'; relativePath: string; name: string; stem: string; ext: string };

    const renameEntries: RenameEntry[] = [
        ...folderRenameList.map((f) => ({
            kind: 'folder' as const,
            relativePath: f.relativePath,
            name: f.name
        })),
        ...trimmableFiles.map((f) => ({
            kind: 'file' as const,
            relativePath: f.relativePath,
            name: f.name,
            stem: f.stem,
            ext: f.ext
        }))
    ];

    const cappedNames = renameEntries.map((e) => {
        if (e.kind === 'folder') {
            const capped = e.name.length > bestCap ? e.name.slice(0, bestCap) : e.name;
            return capped || 'pack';
        }
        const newStem = e.stem.length > bestCap ? e.stem.slice(0, bestCap) : e.stem;
        return newStem + e.ext;
    });

    const parentToChildren = new Map<string, { index: number; newName: string }[]>();
    for (let i = 0; i < renameEntries.length; i++) {
        const e = renameEntries[i];
        const parentRaw = path.win32.dirname(e.relativePath);
        const parentKey = parentRaw === '.' ? '' : parentRaw;
        const arr = parentToChildren.get(parentKey) ?? [];
        arr.push({ index: i, newName: cappedNames[i] });
        parentToChildren.set(parentKey, arr);
    }

    const uniqueNewNames: string[] = [];
    for (let i = 0; i < renameEntries.length; i++) {
        const e = renameEntries[i];
        const parentRaw = path.win32.dirname(e.relativePath);
        const parentKey = parentRaw === '.' ? '' : parentRaw;
        const siblings = parentToChildren.get(parentKey) ?? [];
        const sameCapped = siblings.filter((s) => s.newName === cappedNames[i]);
        const idx = sameCapped.findIndex((s) => s.index === i) + 1;
        uniqueNewNames.push(idx > 1 ? `${cappedNames[i]}_${idx}` : cappedNames[i]);
    }

    const renames: { oldPath: string; newPath: string }[] = [];
    for (let i = 0; i < renameEntries.length; i++) {
        const e = renameEntries[i];
        const newName = uniqueNewNames[i];
        if (e.name === newName) {
            continue;
        }
        const parentRel = path.win32.dirname(e.relativePath);
        const newRel = parentRel && parentRel !== '.' ? path.join(parentRel, newName) : newName;
        renames.push({
            oldPath: path.join(extractRoot, e.relativePath),
            newPath: path.join(extractRoot, newRel)
        });
    }

    renames.sort((a, b) => b.oldPath.length - a.oldPath.length);
    for (const { oldPath, newPath } of renames) {
        await fs.promises.rename(oldPath, newPath);
    }
}

/**
 * After unpack: trim longest path segments so extractFolderName + sep + pathInsideZip stays under
 * MAX_PATH_LENGTH. Prefers pure folders-of-folders, then all folders, then `.adofai` + audio stems.
 */
async function trimRootFoldersForPathLimit(extractRoot: string, zipName: string): Promise<void> {
    const allFolders = await collectFolders(extractRoot, extractRoot);

    const extractFolderName = path.parse(zipName).name || 'pack';
    const pathBudget = Math.max(7, MAX_PATH_LENGTH - 1 - extractFolderName.length);

    const { maxLen } = await getMaxRelativePathAndLength(extractRoot, extractRoot);
    if (maxLen <= pathBudget) {
        return;
    }

    if (allFolders.length === 0) {
        const payloadOnly = await collectTrimmablePayloadFiles(extractRoot, extractRoot);
        if (payloadOnly.length === 0) {
            return;
        }
        const mapFiles = buildTrimmableKindsMap([], payloadOnly);
        const maxSeg = Math.max(
            ...payloadOnly.map((f) => f.stem.length),
            MIN_TRIMMED_SEGMENT_LEN
        );
        const bestCap = await findBestSegmentCap(extractRoot, mapFiles, pathBudget, maxSeg);
        const simOnly = await getMaxPathLengthWithCap(extractRoot, extractRoot, mapFiles, bestCap);
        if (simOnly > pathBudget) {
            logger.warn('Pack path trim: max path may still exceed budget after payload file trim only', {
                pathBudget,
                simulatedMax: simOnly,
                extractFolderName
            });
        }
        await applyPackPathRenames(extractRoot, [], payloadOnly, bestCap);
        return;
    }

    const pureFolderList = allFolders.filter((f) => f.isPureFolderOfFolders);
    const trimmableFoldersPhase1 =
        pureFolderList.length > 0 ? pureFolderList : allFolders;
    const mapPhase1 = buildTrimmableKindsMap(trimmableFoldersPhase1, []);
    const maxSegPhase1 = Math.max(
        ...trimmableFoldersPhase1.map((f) => f.name.length),
        MIN_TRIMMED_SEGMENT_LEN
    );

    let bestCap = await findBestSegmentCap(extractRoot, mapPhase1, pathBudget, maxSegPhase1);
    let folderRenameList: FolderInfo[] = trimmableFoldersPhase1;
    let trimmableFiles: TrimmablePayloadFile[] = [];

    if (pureFolderList.length > 0) {
        const pureMap = buildTrimmableKindsMap(pureFolderList, []);
        const afterPure = await getMaxPathLengthWithCap(extractRoot, extractRoot, pureMap, bestCap);
        if (afterPure > pathBudget && allFolders.length > pureFolderList.length) {
            const mapPhase2 = buildTrimmableKindsMap(allFolders, []);
            const maxSegPhase2 = Math.max(
                ...allFolders.map((f) => f.name.length),
                MIN_TRIMMED_SEGMENT_LEN
            );
            bestCap = await findBestSegmentCap(extractRoot, mapPhase2, pathBudget, maxSegPhase2);
            folderRenameList = allFolders;
        }
    }

    const mapAfterPh12 = buildTrimmableKindsMap(folderRenameList, []);
    let simAfter = await getMaxPathLengthWithCap(extractRoot, extractRoot, mapAfterPh12, bestCap);
    if (simAfter > pathBudget) {
        const payloadFiles = await collectTrimmablePayloadFiles(extractRoot, extractRoot);
        if (payloadFiles.length > 0) {
            const mapPhase3 = buildTrimmableKindsMap(allFolders, payloadFiles);
            const maxSegPhase3 = Math.max(
                ...allFolders.map((f) => f.name.length),
                ...payloadFiles.map((f) => f.stem.length),
                MIN_TRIMMED_SEGMENT_LEN
            );
            bestCap = await findBestSegmentCap(extractRoot, mapPhase3, pathBudget, maxSegPhase3);
            simAfter = await getMaxPathLengthWithCap(extractRoot, extractRoot, mapPhase3, bestCap);
            if (simAfter > pathBudget) {
                logger.warn('Pack path trim: max path may still exceed budget after folder and payload file trim', {
                    pathBudget,
                    simulatedMax: simAfter,
                    extractFolderName
                });
            }
            folderRenameList = allFolders;
            trimmableFiles = payloadFiles;
        } else {
            logger.warn('Pack path trim: over budget but no .adofai/audio entries to shorten', {
                pathBudget,
                simulatedMax: simAfter,
                extractFolderName
            });
        }
    }

    await applyPackPathRenames(extractRoot, folderRenameList, trimmableFiles, bestCap);
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
    clientDownloadId?: string, // Client-provided downloadId for progress tracking
    trimFolderNames = true // When true, shortens folder names for path length compatibility
): Promise<PackDownloadResponse> {
    logger.debug('Generating pack download zip', { zipName, cacheKey, clientDownloadId });
    logger.debug('Tree', { tree });
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
    await broadcastPackJobProgress(initialProgress);

    let targetPath: string | null = null;

    try {
        // Process all nodes and extract to disk
        await processPackNode(tree, '', context);

        // Optionally trim root + folder-only children so extractFolder + path stays under path limit
        if (trimFolderNames) {
            await trimRootFoldersForPathLimit(extractRoot, zipName);
        }

        // Update progress: processing complete, now zipping (explicit line so SSE/message never goes blank)
        await updateProgress(downloadId, cacheKey, {
            status: 'zipping',
            currentLevel: 'Creating pack archive…',
            uploadLoaded: undefined,
            uploadTotal: undefined,
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

        let uploadStats: {size: number};
        try {
            uploadStats = await fs.promises.stat(targetPath);
        } catch {
            uploadStats = {size: 0};
        }

        // Update progress: uploading if using Spaces (initial line before byte callbacks)
        if (spacesKeyFilename) {
            await updateProgress(downloadId, cacheKey, {
                status: 'uploading',
                currentLevel:
                    uploadStats.size > 0
                        ? `Uploading pack to storage — ${formatPackUploadBytes(0, uploadStats.size)}`
                        : 'Uploading pack to storage…',
                uploadLoaded: 0,
                uploadTotal: uploadStats.size > 0 ? uploadStats.size : undefined,
            });
        }

        let uploadProgressLastBroadcast = 0;
        try {
            await spacesStorage.uploadFile(
                targetPath,
                spacesKeyFilename,
                'application/zip',
                {
                    cacheKey,
                    generatedAt: new Date().toISOString(),
                    successLevels: context.successCount.toString(),
                    totalLevels: context.totalLevels.toString(),
                },
                CDN_IMMUTABLE_CACHE_CONTROL,
                (loaded, total) => {
                    const now = Date.now();
                    const effectiveTotal = total > 0 ? total : uploadStats.size;
                    const done = effectiveTotal > 0 && loaded >= effectiveTotal;
                    if (!done && now - uploadProgressLastBroadcast < PACK_UPLOAD_PROGRESS_THROTTLE_MS) {
                        return;
                    }
                    uploadProgressLastBroadcast = now;
                    void updateProgress(downloadId, cacheKey, {
                        status: 'uploading',
                        currentLevel: `Uploading pack to storage — ${formatPackUploadBytes(loaded, effectiveTotal)}`,
                        uploadLoaded: loaded,
                        uploadTotal: effectiveTotal > 0 ? effectiveTotal : undefined,
                    });
                }
            );
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

        // Update progress: completed (URL lives in job meta for SSE clients)
        await updateProgress(downloadId, cacheKey, {
            status: 'completed',
            processedLevels: context.successCount,
            packUrl: responseUrl,
            packZipName: zipName,
            packExpiresAt: response.expiresAt,
            uploadLoaded: undefined,
            uploadTotal: undefined,
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
                error: error instanceof Error ? error.message : String(error),
                uploadLoaded: undefined,
                uploadTotal: undefined,
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

        const storedPath = String(originalZip.path);
        const localCandidate = path.resolve(storedPath);
        if (fs.existsSync(localCandidate)) {
            try {
                const stats = await fs.promises.stat(localCandidate);
                return stats.size;
            } catch {
                return null;
            }
        }

        const head = await spacesStorage.getFileMetadata(storedPath);
        if (head?.ContentLength && head.ContentLength > 0) {
            return head.ContentLength;
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
router.post('/packs/generate', async (req: Request, res: Response) => {
    try {
        const { zipName, tree, cacheKey, packCode, downloadId: clientDownloadId, trimFolderNames } = req.body ?? {};

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
        let finalZipName = zipName.slice(0, 40);
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
                        url = await spacesStorage.getPresignedUrl(entry.spacesKey);
                    } else if (entry.filePath && fs.existsSync(entry.filePath)) {
                        url = `${CDN_CONFIG.baseUrl}/zips/packs/downloads/${existingDownloadId}`;
                    }

                    if (url) {
                        // Notify the **caller's** job id (main API seeds Redis with `downloadId`); optional for legacy callers.
                        const progressJobId =
                            typeof clientDownloadId === 'string' && clientDownloadId.trim().length > 0
                                ? clientDownloadId.trim()
                                : existingDownloadId;
                        const cachedProgress: PackDownloadProgress = {
                            downloadId: progressJobId,
                            cacheKey: entry.cacheKey,
                            status: 'completed',
                            totalLevels: 0,
                            processedLevels: 0,
                            startedAt: Date.now() - (entry.expiresAt - Date.now()),
                            lastUpdated: Date.now(),
                            packUrl: url,
                            packZipName: entry.zipName,
                            packExpiresAt: new Date(entry.expiresAt).toISOString(),
                        };
                        // Send progress update asynchronously (don't wait)
                        broadcastPackJobProgress(cachedProgress).catch(error => {
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

        if (
            !clientDownloadId ||
            typeof clientDownloadId !== 'string' ||
            clientDownloadId.trim().length === 0
        ) {
            return res.status(400).json({
                error: 'downloadId is required',
                code: 'MISSING_DOWNLOAD_ID',
            });
        }

        const trimmedDownloadId = clientDownloadId.trim();
        const sanitizedZipName = sanitizePathSegment(finalZipName);

        if (!packGenerationPromises.has(normalizedCacheKey)) {
            await waitForSpace(sizeEstimate.totalSize, normalizedCacheKey);

            inFlightPackPrimaryJobId.set(normalizedCacheKey, trimmedDownloadId);
            packGenerationJobSubscribers.set(normalizedCacheKey, new Set([trimmedDownloadId]));

            const generationPromise = (async () => {
                try {
                    return await generatePackDownloadZip(
                        sanitizedZipName,
                        tree,
                        normalizedCacheKey,
                        trimmedDownloadId,
                        trimFolderNames !== false,
                    );
                } finally {
                    unregisterGeneration(normalizedCacheKey);
                    packGenerationPromises.delete(normalizedCacheKey);
                    packGenerationJobSubscribers.delete(normalizedCacheKey);
                    inFlightPackPrimaryJobId.delete(normalizedCacheKey);
                }
            })();

            packGenerationPromises.set(normalizedCacheKey, generationPromise);
            generationPromise.catch((err) => {
                logger.error('Pack generation failed (background)', {
                    cacheKey: normalizedCacheKey,
                    downloadId: trimmedDownloadId,
                    error: err instanceof Error ? err.message : String(err),
                });
            });
        } else {
            let subs = packGenerationJobSubscribers.get(normalizedCacheKey);
            if (!subs) {
                subs = new Set<string>();
                packGenerationJobSubscribers.set(normalizedCacheKey, subs);
            }
            subs.add(trimmedDownloadId);

            const primaryId = inFlightPackPrimaryJobId.get(normalizedCacheKey);
            if (primaryId && primaryId !== trimmedDownloadId) {
                const snap = packDownloadProgress.get(primaryId);
                if (snap) {
                    void sendJobProgressIngest(trimmedDownloadId, snap);
                }
            }
        }

        return res.status(202).json({
            downloadId: trimmedDownloadId,
            started: true,
            zipName: sanitizedZipName,
            cacheKey: normalizedCacheKey,
        });
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
                const presignedUrl = await spacesStorage.getPresignedUrl(entry.spacesKey);
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


export default router;
