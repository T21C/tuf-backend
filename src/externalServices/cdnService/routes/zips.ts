import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { logger } from '@/server/services/core/LoggerService.js';
import { cdnLocalTemp } from '../services/cdnLocalTempManager.js';
import { CDN_CONFIG } from '../config.js';
import { processArchiveFile } from '../services/zipProcessor.js';
import {
    extractAll as archiveExtractAll,
    createZip as archiveCreateZip
} from '../services/archiveService.js';
import { Request, Response, Router } from 'express';
import CdnFile from '@/models/cdn/CdnFile.js';
import crypto from 'crypto';
import LevelDict, { analysisUtils } from 'adofai-lib';
import { getSequelizeForModelGroup } from '@/config/db.js';
import { Transaction } from 'sequelize';

const cdnSequelize = getSequelizeForModelGroup('cdn');
import { safeTransactionRollback } from '@/misc/utils/Utility.js';
import { levelCacheService } from '../services/levelCacheService.js';
import { spacesStorage } from '../services/spacesStorage.js';
import { withWorkspace } from '@/server/services/core/WorkspaceService.js';
import { packDownloadDisplayExpiresAtIso } from '@/misc/utils/packDownloadUrlExpiry.js';

const router = Router();

/** Max chars of stdout/stderr to attach to logs (exec can buffer large output). */
const MAX_EXEC_LOG_CHUNK = 32768;

function trimForExecLog(s: string | undefined): string | undefined {
    if (s == null || s === '') return undefined;
    const t = s.trimEnd();
    if (t.length <= MAX_EXEC_LOG_CHUNK) return t;
    return `${t.slice(0, MAX_EXEC_LOG_CHUNK)}… [truncated, total ${t.length} chars]`;
}

/** child_process.exec sets stderr/stdout/code on the error; message alone hides the real failure. */
function execErrorDetails(error: unknown): Record<string, unknown> {
    if (!(error instanceof Error)) {
        return { detail: String(error) };
    }
    const ex = error as Error & {
        cmd?: string;
        code?: number;
        signal?: NodeJS.Signals;
        killed?: boolean;
        stderr?: string;
        stdout?: string;
    };
    const out: Record<string, unknown> = { message: ex.message };
    if (ex.cmd) out.cmd = ex.cmd;
    if (ex.code !== undefined && ex.code !== null) out.exitCode = ex.code;
    if (ex.signal) out.signal = ex.signal;
    if (ex.killed) out.killed = true;
    const stderr = trimForExecLog(ex.stderr);
    const stdout = trimForExecLog(ex.stdout);
    if (stderr) out.stderr = stderr;
    if (stdout) out.stdout = stdout;
    return out;
}

/**
 * Pack downloads live entirely on R2/Spaces; nothing touches local disk beyond the short-lived
 * workspace dir used to assemble the zip. The R2 key is deterministic per (cacheKey, zipName),
 * so repeat requests for the same pack are served by a `fileExists` check rather than any
 * in-memory map + TTL. Stale objects are removed by R2 bucket object lifecycle rules.
 */
const PACK_DOWNLOAD_SPACES_PREFIX = process.env.NODE_ENV === 'development' ? 'pack-downloads-dev' : 'pack-downloads';
const PACK_DOWNLOAD_MAX_SIZE_BYTES = 15 * 1024 * 1024 * 1024; // 15GB hard limit
/** Max path length for extraction (e.g. Windows MAX_PATH 260; extract folder + sep + path inside zip). */
const MAX_PATH_LENGTH = 140;
/** Minimum folder basename / file stem length when trimming (keeps `#5125 …` readable; room for ~100k level ids). */
const PACK_TRIM_MIN_SEGMENT_CHARS = 7;

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
    zipName: string;
    cacheKey: string;
};

/**
 * Coalesces concurrent /packs/generate requests for the same cacheKey so we only build each
 * pack once per process even under burst load. The entry is removed as soon as the generation
 * resolves or rejects.
 */
const packGenerationPromises = new Map<string, Promise<PackDownloadResponse>>();

function envInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

class Semaphore {
    private current = 0;
    private readonly queue: Array<() => void> = [];

    constructor(private readonly max: number) {}

    async acquire(): Promise<() => void> {
        if (this.current < this.max) {
            this.current += 1;
            return () => this.release();
        }
        return new Promise((resolve) => {
            this.queue.push(() => {
                this.current += 1;
                resolve(() => this.release());
            });
        });
    }

    private release(): void {
        this.current = Math.max(0, this.current - 1);
        const next = this.queue.shift();
        if (next) next();
    }
}

// Global resource caps:
// - concurrent pack generations: protects CPU/disk/7z + network streaming
// - per-pack child processing concurrency: avoids unbounded Promise.all on large trees
const PACK_GENERATION_MAX_CONCURRENT = envInt('PACK_DOWNLOAD_MAX_CONCURRENT', 1);
const PACK_NODE_MAX_CONCURRENT = envInt('PACK_DOWNLOAD_NODE_CONCURRENCY', 6);
const packGenerationSemaphore = new Semaphore(PACK_GENERATION_MAX_CONCURRENT);

async function mapWithConcurrency<T>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<void>
): Promise<void> {
    const cap = Math.max(1, concurrency);
    let idx = 0;
    const workers = new Array(Math.min(cap, items.length)).fill(null).map(async () => {
        while (idx < items.length) {
            const i = idx;
            idx += 1;
            await fn(items[i]);
        }
    });
    await Promise.all(workers);
}

// Get main server URL for job progress ingest
function getMainServerUrl(): string {
    if (process.env.NODE_ENV === 'production') {
        return process.env.PROD_API_URL || 'http://localhost:3000';
    } else if (process.env.NODE_ENV === 'staging') {
        return process.env.STAGING_API_URL || 'http://localhost:3000';
    } else {
        return process.env.DEV_URL || 'http://localhost:3002';
    }
}

type PackProgressStatus =
    | 'pending'
    | 'processing'
    | 'zipping'
    | 'uploading'
    | 'completed'
    | 'failed';

/**
 * Pack download URLs are public CDN URLs (not query-signed). Object lifetime is governed by
 * bucket lifecycle. We expose an approximate "link may be rotated/expired after" time for UI
 * (`packDownloadDisplayExpiresAtIso` in `@/misc/utils/packDownloadUrlExpiry.js`).
 */

function packStatusUserMessage(status: PackProgressStatus, currentLevel?: string, error?: string): string {
    if (status === 'failed') {
        return error && error.length > 0 ? error : 'Pack generation failed';
    }
    if (status === 'pending') {
        return 'Starting pack download…';
    }
    if (status === 'processing') {
        return currentLevel ? `Adding level: ${currentLevel}` : 'Downloading levels…';
    }
    if (status === 'zipping') {
        return 'Creating pack zip…';
    }
    if (status === 'uploading') {
        return 'Uploading pack…';
    }
    if (status === 'completed') {
        return 'Pack ready — use Download when you are ready.';
    }
    return 'Working…';
}

async function ingestJobProgress(body: {
    jobId: string;
    kind?: string;
    phase?: string;
    percent?: number | null;
    message?: string;
    meta?: Record<string, unknown>;
    error?: string | null;
}): Promise<void> {
    const secret = process.env.JOB_PROGRESS_INGEST_SECRET;
    if (!secret) {
        logger.debug('JOB_PROGRESS_INGEST_SECRET not set, skipping job progress ingest');
        return;
    }
    const mainServerUrl = getMainServerUrl();
    try {
        await axios.post(`${mainServerUrl}/v2/cdn/job-progress`, body, {
            headers: {'X-Job-Ingest-Key': secret},
            timeout: 5000
        });
    } catch (error) {
        logger.debug('Failed to ingest job progress', {
            jobId: body.jobId,
            error: error instanceof Error ? error.message : String(error)
        });
    }
}

function packPercentFromCounts(processedLevels: number, totalLevels: number): number {
    if (totalLevels <= 0) {
        return 0;
    }
    return Math.min(100, Math.round((processedLevels / totalLevels) * 100));
}

async function emitPackJobProgress(input: {
    downloadId: string;
    cacheKey: string;
    plannedTotalLevels: number;
    processedLevels: number;
    status: PackProgressStatus;
    currentLevel?: string;
    url?: string;
    zipName?: string;
    error?: string;
    /** When set (e.g. R2 upload phase), replaces level-count-based percent. */
    overridePercent?: number | null;
    uploadedBytes?: number;
    totalBytes?: number;
}): Promise<void> {
    const {
        downloadId,
        cacheKey,
        plannedTotalLevels,
        processedLevels,
        status,
        currentLevel,
        url,
        zipName,
        error,
        overridePercent,
        uploadedBytes,
        totalBytes
    } = input;

    const percent: number | null =
        status === 'completed'
            ? 100
            : status === 'failed'
                ? null
                : typeof overridePercent === 'number'
                    ? Math.min(100, Math.max(0, Math.round(overridePercent)))
                    : packPercentFromCounts(processedLevels, plannedTotalLevels);

    const message = packStatusUserMessage(status, currentLevel, error);
    const expiresAt = status === 'completed' ? packDownloadDisplayExpiresAtIso() : undefined;

    // Always send `message` and explicit meta fields: JobProgress merges patches, so omitted
    // fields would otherwise keep stale values (e.g. last "Processing: …" through zipping).
    const meta: Record<string, unknown> = {
        cacheKey,
        totalLevels: plannedTotalLevels,
        processedLevels,
        currentLevel: status === 'processing' && currentLevel ? currentLevel : null
    };
    if (typeof url === 'string' && url.length > 0) {
        meta.url = url;
    }
    if (typeof zipName === 'string' && zipName.length > 0) {
        meta.zipName = zipName;
    }
    if (expiresAt) {
        meta.expiresAt = expiresAt;
    }
    if (status === 'completed' || status === 'failed') {
        meta.uploadedBytes = null;
        meta.totalBytes = null;
    } else if (typeof uploadedBytes === 'number' || typeof totalBytes === 'number') {
        meta.uploadedBytes = uploadedBytes ?? null;
        meta.totalBytes = totalBytes ?? null;
    }

    await ingestJobProgress({
        jobId: downloadId,
        kind: 'pack_download',
        phase: status,
        percent,
        message,
        meta,
        error: status === 'failed' ? (error ?? 'Pack generation failed') : null
    });
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

/**
 * Build the deterministic R2 object key for a cached pack. Keyed on cacheKey (derived from the
 * requested tree + zip name) so the same request always hits the same object; the human-readable
 * filename is preserved as the final path segment so browsers pick it up via the CDN URL.
 */
function buildPackSpacesKey(cacheKey: string, zipName: string): string {
    const sanitized = sanitizePathSegment(zipName) || 'pack';
    return `${PACK_DOWNLOAD_SPACES_PREFIX}/${cacheKey}/${sanitized}.zip`;
}

interface PackGenerationContext {
    tempDir: string;
    extractRoot: string;
    successCount: number;
    totalLevels: number;
    /** Total .adofai levels in tree (for progress percent). */
    plannedTotalLevels: number;
    downloadId: string;
    cacheKey: string;
    /** Aborts on shutdown or workspace teardown; long-running steps should honour it. */
    signal: AbortSignal;
}

async function streamSpacesFileToDisk(spacesKey: string, targetPath: string): Promise<void> {
    await spacesStorage.downloadFileToPathStreaming(spacesKey, targetPath);
}

async function extractZipToFolder(zipPath: string, extractTo: string, signal?: AbortSignal): Promise<void> {
    // archiveService handles the cross-platform 7z spawn, UTF-8 locale, warning vs. fatal
    // exit code distinction, and works with any supported archive format (zip/rar/7z/tar/gz).
    await archiveExtractAll(zipPath, extractTo, signal);
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

        const zipExists = await spacesStorage.fileExists(originalZip.path);
        if (!zipExists) {
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
            if (zipExists) {
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
                throw { error: 'Original zip file not found in storage', code: 400 };
            }

            const derivedFromZip = originalZip.originalFilename || originalZip.name;
            const zipBaseName = derivedFromZip ? path.parse(derivedFromZip).name : null;
            const baseFolderName = node.name || zipBaseName || `Level-${node.levelId ?? 'unknown'}`;
            finalFolderName = buildLevelFolderName(node, baseFolderName);
            const targetFolder = parentPath
                ? path.join(context.extractRoot, parentPath, finalFolderName)
                : path.join(context.extractRoot, finalFolderName);

            // Extract zip to target folder on disk
            await extractZipToFolder(zipPath, targetFolder, context.signal);

            // Delete temp zip file immediately after successful extraction to free up space
            // Only delete if it's a temp file we created (from Spaces), not the original source file
            if (tempZipPath && zipExists) {
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
            } else {
                logger.debug('Skipping temp zip deletion (not a temp file)', {
                    tempZipPath,
                    fileId: node.fileId
                });
            }

            context.successCount += 1;
            const relativeFolderName = parentPath
                ? path.posix.join(parentPath, finalFolderName)
                : finalFolderName;

            // Update progress after successful level extraction
            await emitPackJobProgress({
                downloadId: context.downloadId,
                cacheKey: context.cacheKey,
                plannedTotalLevels: context.plannedTotalLevels,
                processedLevels: context.successCount,
                status: 'processing',
                currentLevel: finalFolderName
            });

            return { folderName: relativeFolderName, success: true };
        } finally {
            // Clean up temp zip file if extraction failed (fallback cleanup)
            // Only delete if it's a temp file we created (from Spaces)
            if (tempZipPath && zipExists) {
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
                    hasExistence: !!zipExists,
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
            timeout: 30_000, // Increased timeout for large files
            signal: context.signal
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
        await extractZipToFolder(tempZipPath, targetFolder, context.signal);

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
        await emitPackJobProgress({
            downloadId: context.downloadId,
            cacheKey: context.cacheKey,
            plannedTotalLevels: context.plannedTotalLevels,
            processedLevels: context.successCount,
            status: 'processing',
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

/**
 * Pack path trimming walks the extract tree; unreadable dirs (encoding / FS quirks) must not abort the job.
 * Returns an empty list for that branch so trimming uses partial data or becomes a no-op.
 */
async function packSafeReadDir(dir: string): Promise<fs.Dirent[]> {
    try {
        return await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        logger.warn('Pack path trim: skipping unreadable directory', {
            dir,
            code: e.code,
            message: e.message
        });
        return [];
    }
}

/** Returns max relative path length over all paths, and the path that achieved it. */
async function getMaxRelativePathAndLength(dir: string, root: string): Promise<{ maxLen: number; maxPath: string }> {
    let maxLen = 0;
    let maxPath = '';
    const entries = await packSafeReadDir(dir);
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

function splitWorstRelativePath(maxPath: string): string[] {
    const norm = path.win32.normalize(maxPath).replace(/\//g, PATH_SEP);
    return norm.split(PATH_SEP).filter((s) => s.length > 0);
}

/** Level charts and loose audio in level folders — safe to shorten for path budget (game can re-pick song). */
const TRIMMABLE_PACK_AUDIO_EXT = new Set([
    '.mp3', '.wav', '.ogg', '.oga', '.opus', '.flac', '.m4a', '.aac',
    '.aiff', '.aif', '.caf', '.wma', '.webm', '.mka', '.ac3', '.eac3',
    '.mp2', '.amr', '.ape', '.wv', '.tta'
]);

function isTrimmablePackFileBasename(basename: string): boolean {
    const ext = path.extname(basename).toLowerCase();
    return ext === '.adofai' || TRIMMABLE_PACK_AUDIO_EXT.has(ext);
}

type TrimPathCandidate =
    | { kind: 'folder'; fullPath: string; parentDir: string; currentName: string }
    | { kind: 'file'; fullPath: string; parentDir: string; currentName: string };

/** All `.adofai` + trimmable audio files in a level folder (same pass as chart/song trimming). */
async function listTrimmablePackFileSiblingsInDir(parentDir: string): Promise<TrimPathCandidate[]> {
    const entries = await packSafeReadDir(parentDir);
    const out: TrimPathCandidate[] = [];
    for (const e of entries) {
        if (!e.isFile() || !isTrimmablePackFileBasename(e.name)) {
            continue;
        }
        const fullPath = path.join(parentDir, e.name);
        try {
            const st = await fs.promises.stat(fullPath);
            if (!st.isFile()) {
                continue;
            }
        } catch {
            continue;
        }
        out.push({ kind: 'file', fullPath, parentDir, currentName: e.name });
    }
    return out;
}

/**
 * Folders on the worst relative path, plus every `.adofai` / trimmable-audio file inside **each**
 * directory on that path (all ancestors of the leaf). Deduplicated, then sorted by **basename
 * length descending** so long parent folder names compete with songs/charts — one rename per
 * outer iteration trims the single longest name still above the floor, spreading cuts across
 * entries instead of over-shortening children while a long parent stays untouched.
 */
async function listTrimCandidatesOnWorstPathByNameLength(
    extractRoot: string,
    maxPath: string
): Promise<TrimPathCandidate[]> {
    const segments = splitWorstRelativePath(maxPath);
    if (segments.length === 0) {
        return [];
    }

    const out: TrimPathCandidate[] = [];
    const seenPath = new Set<string>();

    const pushUnique = (c: TrimPathCandidate) => {
        if (seenPath.has(c.fullPath)) {
            return;
        }
        seenPath.add(c.fullPath);
        out.push(c);
    };

    for (let i = 0; i < segments.length; i++) {
        const fullPath = path.join(extractRoot, ...segments.slice(0, i + 1));
        let st: fs.Stats;
        try {
            st = await fs.promises.stat(fullPath);
        } catch {
            break;
        }

        const currentName = segments[i];
        const parentDir = i === 0 ? extractRoot : path.join(extractRoot, ...segments.slice(0, i));

        if (st.isDirectory()) {
            pushUnique({ kind: 'folder', fullPath, parentDir, currentName });
            const filesInDir = await listTrimmablePackFileSiblingsInDir(fullPath);
            for (const f of filesInDir) {
                pushUnique(f);
            }
            continue;
        }

        if (st.isFile()) {
            if (isTrimmablePackFileBasename(currentName)) {
                pushUnique({ kind: 'file', fullPath, parentDir, currentName });
            }
            break;
        }

        break;
    }

    out.sort((a, b) => {
        const d = b.currentName.length - a.currentName.length;
        if (d !== 0) {
            return d;
        }
        if (a.kind !== b.kind) {
            return a.kind === 'folder' ? -1 : 1;
        }
        return a.fullPath.localeCompare(b.fullPath);
    });
    return out;
}

/** Pick `base` or `base_2`, `base_3`, ... so the name is not used by another entry under `parentDir`. */
async function allocateSiblingFolderName(parentDir: string, base: string): Promise<string> {
    const entries = await packSafeReadDir(parentDir);
    const taken = new Set(entries.map((e) => e.name));
    if (!taken.has(base)) {
        return base;
    }
    for (let i = 2; i < 1_000_000; i++) {
        const candidate = `${base}_${i}`;
        if (!taken.has(candidate)) {
            return candidate;
        }
    }
    return `${base}_${Date.now()}`;
}

/** Unique `stem + ext` or `stem_N + ext` under `parentDir` (for greedy file renames). */
async function allocateSiblingStemName(parentDir: string, stem: string, ext: string): Promise<string> {
    const entries = await packSafeReadDir(parentDir);
    const taken = new Set(entries.map((e) => e.name));
    const full = (s: string) => `${s}${ext}`;
    if (!taken.has(full(stem))) {
        return full(stem);
    }
    for (let i = 2; i < 1_000_000; i++) {
        const candidate = `${stem}_${i}${ext}`;
        if (!taken.has(candidate)) {
            return candidate;
        }
    }
    return `${stem}_${Date.now()}${ext}`;
}

/**
 * After unpack, shorten **individual** path segments (folders, `.adofai`, or common audio files) on
 * the longest offending path until the worst-case relative path fits under the Windows-oriented
 * budget (extract folder name + path inside zip). Greedy: each step renames **one** entry — the
 * longest basename among folders on the worst path and all `.adofai`/audio files under every
 * directory on that path — so long parent folder names are trimmed before over-cutting children.
 * Stem-only for files (extension kept). Names are never shortened below {@link PACK_TRIM_MIN_SEGMENT_CHARS}
 * characters when the original was longer (keeps `#5125 …` style prefixes readable).
 *
 * Directory walks use {@link packSafeReadDir}: unreadable subtrees are skipped when measuring.
 */
async function trimRootFoldersForPathLimit(extractRoot: string, zipName: string): Promise<void> {
    const extractFolderName = path.parse(zipName).name || 'pack';
    const pathBudget = Math.max(1, MAX_PATH_LENGTH - 1 - extractFolderName.length);

    const MAX_ITERS = 5000;
    for (let iter = 0; iter < MAX_ITERS; iter++) {
        const { maxLen, maxPath } = await getMaxRelativePathAndLength(extractRoot, extractRoot);
        if (maxLen <= pathBudget) {
            return;
        }

        const candidates = await listTrimCandidatesOnWorstPathByNameLength(extractRoot, maxPath);
        if (candidates.length === 0) {
            logger.warn('Pack path trim: over budget but no trimmable segments on worst path', {
                maxLen,
                pathBudget,
                maxPath
            });
            return;
        }

        const excess = maxLen - pathBudget;
        let renamedThisRound = false;

        for (const pick of candidates) {
            if (!fs.existsSync(pick.fullPath)) {
                continue;
            }

            if (pick.kind === 'file') {
                const { fullPath: fileFullPath, parentDir, currentName } = pick;
                const ext = path.extname(currentName);
                const stem = ext ? currentName.slice(0, -ext.length) : currentName;
                if (!stem || stem.length < 1) {
                    continue;
                }

                const stemFloor = Math.min(PACK_TRIM_MIN_SEGMENT_CHARS, stem.length);
                const shortenStemBy = Math.min(excess, Math.max(0, stem.length - stemFloor));
                if (shortenStemBy <= 0) {
                    continue;
                }

                const maxStemLen = Math.max(stemFloor, stem.length - shortenStemBy);

                for (let targetStemLen = maxStemLen; targetStemLen >= stemFloor; targetStemLen--) {
                    let newStem = stem.slice(0, targetStemLen).trim();
                    if (!newStem || newStem.length < stemFloor) {
                        newStem = stem.slice(0, stemFloor);
                    }
                    if (!newStem) {
                        newStem = ext === '.adofai' ? 'level' : 'track';
                    }

                    const newName = await allocateSiblingStemName(parentDir, newStem, ext);
                    const newFullPath = path.join(parentDir, newName);

                    if (newFullPath === fileFullPath || newName === currentName) {
                        continue;
                    }

                    if (newName.length > currentName.length) {
                        continue;
                    }

                    await fs.promises.rename(fileFullPath, newFullPath);
                    logger.debug('Pack path trim: greedy file shorten', {
                        from: fileFullPath,
                        to: newFullPath,
                        maxLenBefore: maxLen,
                        pathBudget,
                        iter
                    });
                    renamedThisRound = true;
                    break;
                }
            } else {
                const { fullPath: folderFullPath, parentDir, currentName } = pick;
                const floorLen = Math.min(PACK_TRIM_MIN_SEGMENT_CHARS, currentName.length);
                const shortenBy = Math.min(excess, Math.max(0, currentName.length - floorLen));
                if (shortenBy <= 0) {
                    continue;
                }

                const maxTargetLen = Math.max(floorLen, currentName.length - shortenBy);

                for (let targetLen = maxTargetLen; targetLen >= floorLen; targetLen--) {
                    let base = currentName.slice(0, targetLen).trim();
                    if (!base || base.length < floorLen) {
                        base = currentName.slice(0, floorLen);
                    }
                    if (!base) {
                        continue;
                    }

                    const newName = await allocateSiblingFolderName(parentDir, base);
                    const newFullPath = path.join(parentDir, newName);

                    if (newFullPath === folderFullPath || newName === currentName) {
                        continue;
                    }

                    if (newName.length > currentName.length) {
                        continue;
                    }

                    await fs.promises.rename(folderFullPath, newFullPath);
                    logger.debug('Pack path trim: greedy folder shorten', {
                        from: folderFullPath,
                        to: newFullPath,
                        maxLenBefore: maxLen,
                        pathBudget,
                        iter
                    });
                    renamedThisRound = true;
                    break;
                }
            }

            if (renamedThisRound) {
                break;
            }
        }

        if (!renamedThisRound) {
            logger.warn('Pack path trim: over budget but no segment could be shortened', {
                maxLen,
                pathBudget,
                maxPath,
                iter
            });
            return;
        }
    }

    logger.warn('Pack path trim: stopped after max iterations', {
        extractRoot,
        maxIters: MAX_ITERS
    });
}

async function processPackNode(node: PackDownloadNode, parentPath: string, context: PackGenerationContext): Promise<void> {
    // Fail fast if we've been asked to shut down; avoids downloading the next level into a
    // workspace that's about to be deleted.
    if (context.signal.aborted) {
        throw new Error('Pack generation aborted');
    }
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
            // Bounded concurrency: protects CPU/disk/network and avoids event loop starvation
            // for huge pack trees.
            await mapWithConcurrency(children, PACK_NODE_MAX_CONCURRENT, (child) =>
                processPackNode(child, folderPath, context)
            );
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
    const downloadId = clientDownloadId || crypto.randomUUID();
    const totalLevels = countTotalLevels(tree);
    const spacesKey = buildPackSpacesKey(cacheKey, zipName);

    await emitPackJobProgress({
        downloadId,
        cacheKey,
        plannedTotalLevels: totalLevels,
        processedLevels: 0,
        status: 'processing'
    });

    try {
        const release = await packGenerationSemaphore.acquire();
        const response = await withWorkspace('pack-download', async (ws) => {
            // Extracted source files live next to the final zip inside the workspace; both are
            // removed automatically when the workspace lease ends, regardless of outcome.
            const extractRoot = ws.join('extract');
            const targetPath = ws.join('output.zip');
            await fs.promises.mkdir(extractRoot, { recursive: true });

            const context: PackGenerationContext = {
                tempDir: ws.dir,
                extractRoot,
                successCount: 0,
                totalLevels: 0,
                plannedTotalLevels: totalLevels,
                downloadId,
                cacheKey,
                signal: ws.signal
            };

            await processPackNode(tree, '', context);

            if (trimFolderNames) {
                await trimRootFoldersForPathLimit(extractRoot, zipName);
            }

            let lastZipProgressEmit = 0;
            let lastZipProgressPercent = -1;
            const onZipProgress = (rawPct: number) => {
                const pct = Math.min(99, Math.max(0, Math.round(rawPct)));
                const now = Date.now();
                if (now - lastZipProgressEmit < 500 && pct - lastZipProgressPercent < 1) {
                    return;
                }
                lastZipProgressEmit = now;
                lastZipProgressPercent = pct;
                void emitPackJobProgress({
                    downloadId,
                    cacheKey,
                    plannedTotalLevels: totalLevels,
                    processedLevels: context.successCount,
                    status: 'zipping',
                    overridePercent: pct
                });
            };

            await emitPackJobProgress({
                downloadId,
                cacheKey,
                plannedTotalLevels: totalLevels,
                processedLevels: context.successCount,
                status: 'zipping',
                overridePercent: 0
            });

            // archiveService runs 7z with -tzip -mx=0 -mm=Copy -r -mcu=on for store-only zip
            // creation; ws.signal kills the child on SIGINT/SIGTERM so shutdown isn't blocked
            // waiting for a multi-GB archive to finish. Stderr `%` lines drive zipping progress.
            try {
                await archiveCreateZip(extractRoot, targetPath, {
                    signal: ws.signal,
                    onZipProgress
                });
            } catch (error) {
                logger.error('Failed to create pack zip via archiveService', {
                    ...execErrorDetails(error),
                    extractRoot,
                    targetPath
                });
                throw error;
            }

            await emitPackJobProgress({
                downloadId,
                cacheKey,
                plannedTotalLevels: totalLevels,
                processedLevels: context.successCount,
                status: 'zipping',
                overridePercent: 100
            });

            const zipStat = await fs.promises.stat(targetPath);
            let lastPackUploadEmit = 0;
            let lastPackUploadPercent = -1;
            const onPackUploadProgress = (loaded: number, total: number) => {
                const pct = total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 0;
                const now = Date.now();
                if (now - lastPackUploadEmit < 500 && pct - lastPackUploadPercent < 1) {
                    return;
                }
                lastPackUploadEmit = now;
                lastPackUploadPercent = pct;
                void emitPackJobProgress({
                    downloadId,
                    cacheKey,
                    plannedTotalLevels: totalLevels,
                    processedLevels: context.successCount,
                    status: 'uploading',
                    overridePercent: pct,
                    uploadedBytes: loaded,
                    totalBytes: total
                });
            };

            await emitPackJobProgress({
                downloadId,
                cacheKey,
                plannedTotalLevels: totalLevels,
                processedLevels: context.successCount,
                status: 'uploading',
                overridePercent: 0,
                uploadedBytes: 0,
                totalBytes: zipStat.size
            });

            await spacesStorage.uploadFile(
                targetPath,
                spacesKey,
                'application/zip',
                {
                    cacheKey,
                    generatedAt: new Date().toISOString(),
                    successLevels: context.successCount.toString(),
                    totalLevels: context.totalLevels.toString()
                },
                undefined,
                onPackUploadProgress
            );

            const responseUrl = await spacesStorage.getPresignedUrl(spacesKey);

            return {
                downloadId,
                url: responseUrl,
                zipName,
                cacheKey,
                successCount: context.successCount,
                totalLevels: context.totalLevels
            };
        }).finally(() => {
            release();
        });

        await emitPackJobProgress({
            downloadId,
            cacheKey,
            plannedTotalLevels: totalLevels,
            processedLevels: response.successCount,
            status: 'completed',
            url: response.url,
            zipName: response.zipName,
        });

        logger.debug('Generated pack download zip', {
            downloadId,
            zipName,
            cacheKey,
            successLevels: response.successCount,
            totalLevels: response.totalLevels,
            spacesKey
        });

        return {
            downloadId: response.downloadId,
            url: response.url,
            zipName: response.zipName,
            cacheKey: response.cacheKey
        };
    } catch (error) {
        await emitPackJobProgress({
            downloadId,
            cacheKey,
            plannedTotalLevels: totalLevels,
            processedLevels: 0,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
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
        const zipExists = await spacesStorage.fileExists(originalZip.path);

        if (!zipExists) {
            return null;
        }

        const headResult = await spacesStorage.getFileMetadata(originalZip.path);
        return headResult?.ContentLength ?? null;
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
                relativePath?: string;
                path: string;
                size: number;
                hasYouTubeStream?: boolean;
                songFilename?: string;
            }>;
        };

        if (!allLevelFiles || !Array.isArray(allLevelFiles)) {
            logger.debug('No level files found in metadata:', { fileId });
            return res.status(404).json({ error: 'No level files found' });
        }

        // Get fresh analysis for each level file
        const levelFiles = await Promise.all(allLevelFiles.map(async (file) => {
            try {
                const levelExists = await spacesStorage.fileExists(file.path);
                if (!levelExists) {
                    throw new Error('Level file not found in storage');
                }

                if (!levelExists) {
                    throw new Error('Level file not found in storage');
                }
                const levelDict = await withWorkspace('pack-download', async (ws) => {
                    const tempPath = ws.join(`inspect_${fileId}_${Date.now()}.adofai`);
                    await spacesStorage.downloadFileToPathStreaming(file.path, tempPath);
                    return new LevelDict(tempPath);
                });

                return {
                    name: file.name,
                    relativePath: file.relativePath,
                    fullPath: file.relativePath || file.path,
                    storagePath: file.path,
                    size: file.size,
                    hasYouTubeStream: levelDict.getSetting('requiredMods')?.includes('YouTubeStream'),
                    songFilename: levelDict.getSetting('songFilename'),
                    artist: levelDict.getSetting('artist'),
                    song: levelDict.getSetting('song'),
                    author: levelDict.getSetting('author'),
                    difficulty: levelDict.getSetting('difficulty'),
                    bpm: levelDict.getSetting('bpm'),
                    levelLengthInMs: analysisUtils.getLevelLengthInMs(levelDict)
                };
            } catch (error) {
                logger.error('Failed to analyze level file:', {
                    error: error instanceof Error ? error.message : String(error),
                    path: file.path
                });
                return {
                    name: file.name,
                    relativePath: file.relativePath,
                    fullPath: file.relativePath || file.path,
                    storagePath: file.path,
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

        const sanitizedZipName = sanitizePathSegment(finalZipName);
        const cachedSpacesKey = buildPackSpacesKey(normalizedCacheKey, sanitizedZipName);

        // Cache hit: R2 already has this pack. Serve its URL directly without rebuilding.
        try {
            if (await spacesStorage.fileExists(cachedSpacesKey)) {
                const url = await spacesStorage.getPresignedUrl(cachedSpacesKey);
                const reusedDownloadId = clientDownloadId || crypto.randomUUID();
                const expiresAt = packDownloadDisplayExpiresAtIso();

                ingestJobProgress({
                    jobId: reusedDownloadId,
                    kind: 'pack_download',
                    phase: 'completed',
                    percent: 100,
                    message: 'Pack ready (cached).',
                    meta: {
                        cacheKey: normalizedCacheKey,
                        totalLevels: 0,
                        processedLevels: 0,
                        url,
                        zipName: finalZipName,
                        reused: true,
                        currentLevel: null,
                        expiresAt
                    },
                    error: null
                }).catch(error => {
                    logger.debug('Failed to ingest cached pack job progress', {
                        downloadId: reusedDownloadId,
                        error: error instanceof Error ? error.message : String(error)
                    });
                });

                return res.json({
                    downloadId: reusedDownloadId,
                    url,
                    zipName: finalZipName,
                    cacheKey: normalizedCacheKey,
                    expiresAt
                });
            }
        } catch (error) {
            logger.warn('Failed to probe R2 for cached pack download; regenerating', {
                cacheKey: normalizedCacheKey,
                error: error instanceof Error ? error.message : String(error)
            });
        }

        const downloadId = clientDownloadId || crypto.randomUUID();

        // In-process coalescing: if another request is already building this same pack, reuse it
        // instead of kicking off a duplicate workspace + 7z run.
        let generationPromise = packGenerationPromises.get(normalizedCacheKey);
        const startedNew = !generationPromise;
        if (startedNew) {
            generationPromise = (async () => {
                try {
                    return await generatePackDownloadZip(
                        sanitizedZipName,
                        tree,
                        normalizedCacheKey,
                        downloadId,
                        trimFolderNames !== false
                    );
                } finally {
                    packGenerationPromises.delete(normalizedCacheKey);
                }
            })();
            packGenerationPromises.set(normalizedCacheKey, generationPromise);
        }

        // Ensure the job exists immediately so subscribers get an early snapshot.
        // (Any later updates are also fine; this just avoids long "waiting" states.)
        if (startedNew) {
            emitPackJobProgress({
                downloadId,
                cacheKey: normalizedCacheKey,
                plannedTotalLevels: countTotalLevels(tree),
                processedLevels: 0,
                status: 'processing',
                zipName: finalZipName,
            }).catch(() => {
                /* ignore - background job progress is best-effort */
            });
        }

        // Fire-and-forget: the generator will emit progress and terminal state to the main server.
        if (!generationPromise) {
            // Defensive: should be impossible because we always set the promise above.
            throw new Error('Pack generation promise is missing');
        }

        generationPromise.catch(() => {
            /* terminal failure progress is emitted inside generatePackDownloadZip */
        });

        // Always return immediately to avoid request timeouts.
        return res.status(202).json({
            downloadId,
            started: true,
            zipName: finalZipName,
            cacheKey: normalizedCacheKey
        });
    } catch (error) {
        logger.error('Failed to generate pack download zip', {
            ...execErrorDetails(error)
        });
        return res.status(500).json({
            error: 'Failed to generate pack download',
            code: 'PACK_DOWNLOAD_ERROR'
        });
    }
});

/** Long `Error.message` (e.g. full 7z stderr) is logged as-is; cap what we return to the client / job progress. */
const CLIENT_FACING_ERROR_MAX = 1600;
function truncateClientErrorMessage(msg: string): string {
    if (msg.length <= CLIENT_FACING_ERROR_MAX) return msg;
    return `${msg.slice(0, CLIENT_FACING_ERROR_MAX)}… [truncated; see server logs for full 7z output]`;
}

// Send level upload progress update to main server
async function sendLevelUploadProgress(
    uploadId: string | undefined,
    status: 'uploading' | 'processing' | 'caching' | 'failed',
    progressPercent: number,
    currentStep?: string,
    error?: string
): Promise<void> {
    if (!uploadId) {
        return;
    }

    // Do not send `kind` here — the main server already set the job kind (`level_upload`,
    // `level_submission_upload`, etc.); overwriting would break submission progress UX.
    await ingestJobProgress({
        jobId: uploadId,
        phase: status,
        percent: progressPercent,
        message: currentStep,
        meta: {},
        error: status === 'failed' ? (error ?? 'Upload failed') : null
    });
}

// Level zip upload endpoint
router.post('/', (req: Request, res: Response) => {
    logger.debug('Received zip upload request');

    cdnLocalTemp.upload(req, res, async (err) => {
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

        const uploadId = req.headers['x-upload-id'] as string | undefined;
        if (!uploadId || typeof uploadId !== 'string' || uploadId.trim().length === 0) {
            cdnLocalTemp.cleanupFiles(req.file.path);
            return res.status(400).json({ error: 'X-Upload-Id header is required' });
        }
        const fileId = crypto.randomUUID();
        logger.debug('Generated UUID for database entry:', { fileId });

        const buildClientFacingError = (error: unknown): {
            clientMessage: string;
            clientDetails: Record<string, unknown>;
            isClientFacing: boolean;
        } => {
            const fullMessage = error instanceof Error ? error.message : String(error);
            const errWithZ = error instanceof Error
                ? (error as Error & {
                      exitCode?: number;
                      sevenZSummary?: string;
                      sevenZBinary?: string;
                      clientFacing?: boolean;
                      archiveErrorKind?: string;
                      userMessage?: string;
                  })
                : null;

            const isClientFacing = !!errWithZ?.clientFacing;

            if (isClientFacing) {
                logger.warn('Zip upload rejected (user error):', {
                    archiveErrorKind: errWithZ?.archiveErrorKind,
                    userMessage: errWithZ?.userMessage,
                    file: req.file
                        ? {
                              originalname: req.file.originalname,
                              size: req.file.size
                          }
                        : null
                });
            } else {
                logger.error('Error during zip upload process:', {
                    error: fullMessage,
                    stack: error instanceof Error ? error.stack : undefined,
                    ...(typeof errWithZ?.exitCode === 'number' ? { sevenZExitCode: errWithZ.exitCode } : {}),
                    ...(typeof errWithZ?.sevenZBinary === 'string' ? { sevenZBinary: errWithZ.sevenZBinary } : {}),
                    ...(typeof errWithZ?.sevenZSummary === 'string' ? { sevenZSummary: errWithZ.sevenZSummary } : {}),
                    file: req.file
                        ? {
                              originalname: req.file.originalname,
                              size: req.file.size,
                              path: req.file.path
                          }
                        : null
                });
            }

            let clientMessage: string;
            let clientDetails: Record<string, unknown>;
            if (isClientFacing && errWithZ?.userMessage) {
                clientMessage = errWithZ.userMessage;
                clientDetails = {
                    message: errWithZ.userMessage,
                    archiveErrorKind: errWithZ.archiveErrorKind
                };
            } else {
                try {
                    const parsedError = JSON.parse(fullMessage);
                    const parsedMessage = parsedError.details?.message || parsedError.message;
                    clientMessage = parsedMessage;
                    clientDetails = {
                        message: parsedMessage,
                        ...parsedError.details
                    };
                } catch {
                    clientMessage = truncateClientErrorMessage(fullMessage);
                    clientDetails = { message: clientMessage };
                }
            }

            return { clientMessage, clientDetails, isClientFacing };
        };

        const runZipIngest = async (): Promise<void> => {
            await sendLevelUploadProgress(uploadId, 'uploading', 0, 'Uploading file to server');

            logger.debug('Starting archive file processing');

            const onProgress = async (
                status: 'uploading' | 'processing' | 'caching' | 'failed',
                progressPercent: number,
                currentStep?: string
            ) => {
                await sendLevelUploadProgress(uploadId, status, progressPercent, currentStep);
            };

            await processArchiveFile(req.file!.path, fileId, req.file!.originalname, onProgress);
            logger.debug('Successfully processed archive file');

            logger.debug('Cleaning up original archive file');
            cdnLocalTemp.cleanupFiles(req.file!.path);
            logger.debug('Original archive file cleaned up');

            await sendLevelUploadProgress(uploadId, 'caching', 95, 'Populating cache');
            logger.debug('Populating cache for uploaded level:', { fileId });
            try {
                await levelCacheService.ensureCachePopulated(fileId);
                logger.debug('Cache populated successfully for uploaded level:', { fileId });
            } catch (cacheError) {
                logger.warn('Failed to populate cache for uploaded level (non-critical):', {
                    fileId,
                    error: cacheError instanceof Error ? cacheError.message : String(cacheError)
                });
            }

            if (uploadId) {
                await ingestJobProgress({
                    jobId: uploadId,
                    phase: 'cdn_ingest_done',
                    percent: 100,
                    message: 'CDN ingest complete',
                    meta: {cdnFileId: fileId},
                    error: null
                });
            }
        };

        const handleFailure = async (error: unknown, options: { writeHttp: boolean }): Promise<void> => {
            const { clientMessage, clientDetails } = buildClientFacingError(error);
            await sendLevelUploadProgress(uploadId, 'failed', 0, 'Upload failed', clientMessage);
            cdnLocalTemp.cleanupFiles(req.file!.path);

            if (options.writeHttp && !res.headersSent && !res.writableEnded) {
                res.status(400).json({
                    error: clientMessage,
                    code: 'VALIDATION_ERROR',
                    details: clientDetails
                });
            }
        };

        // Always async: return immediately after receiving the upload.
        res.status(202).json({
            success: true,
            fileId,
            url: `${CDN_CONFIG.baseUrl}/${fileId}`,
            async: true
        });

        void runZipIngest().catch(async (e) => {
            await handleFailure(e, { writeHttp: false });
        });
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
        transaction = await cdnSequelize.transaction();

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
                relativePath?: string;
                path: string;
                size: number;
                hasYouTubeStream?: boolean;
                songFilename?: string;
            }>;
            targetLevel: string | null;
            targetLevelRelativePath?: string | null;
            pathConfirmed: boolean;
        };

        // Get the target filename regardless of path
        const targetFilename = path.basename(targetLevel);
        const normalizedTargetPath = String(targetLevel).replace(/\\/g, '/').replace(/^\/+/, '');

        const directMatches = metadata.allLevelFiles.filter(file => {
            const filePath = file.path.replace(/\\/g, '/');
            return filePath === normalizedTargetPath || filePath === String(targetLevel).replace(/\\/g, '/');
        });

        const relativeMatches = metadata.allLevelFiles.filter(file => {
            const relativePath = (file.relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
            return relativePath.length > 0 && (
                relativePath === normalizedTargetPath ||
                relativePath.endsWith(`/${normalizedTargetPath}`)
            );
        });

        const basenameMatches = metadata.allLevelFiles.filter(file =>
            path.basename((file.relativePath || file.path).replace(/\\/g, '/')) === targetFilename
        );

        let matchingLevel: (typeof metadata.allLevelFiles)[number] | undefined;
        if (directMatches.length > 0) {
            matchingLevel = directMatches[0];
        } else if (relativeMatches.length === 1) {
            matchingLevel = relativeMatches[0];
        } else if (relativeMatches.length > 1) {
            await safeTransactionRollback(transaction);
            return res.status(400).json({
                error: 'Target level path is ambiguous',
                candidates: relativeMatches.map(level => level.relativePath || level.path)
            });
        } else if (basenameMatches.length === 1) {
            matchingLevel = basenameMatches[0];
        } else if (basenameMatches.length > 1) {
            await safeTransactionRollback(transaction);
            return res.status(400).json({
                error: 'Target filename is ambiguous across subfolders',
                candidates: basenameMatches.map(level => level.relativePath || level.path)
            });
        }

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
                targetLevelRelativePath: matchingLevel.relativePath || null,
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

        const fileAfterCommit = await CdnFile.findByPk(fileId);
        if (!fileAfterCommit) {
            logger.error('CdnFile missing after target-level commit', { fileId });
            return res.status(500).json({ error: 'File missing after update' });
        }

        await levelCacheService.clearCache(fileAfterCommit);
        const cacheData = await levelCacheService.ensureCachePopulated(fileId);
        if (!cacheData) {
            logger.error('Failed to rebuild level cache after target level change', { fileId });
            return res.status(500).json({
                error: 'Failed to rebuild level cache after target change',
                code: 'LEVEL_CACHE_REBUILD_FAILED'
            });
        }
        logger.debug('Cache rebuilt for new target level:', { fileId });

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
