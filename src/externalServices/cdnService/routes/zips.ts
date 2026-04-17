import path from 'path';
import fs from 'fs';
import AdmZip from 'adm-zip';
import axios from 'axios';
import { logger } from '@/server/services/core/LoggerService.js';
import { cdnLocalTemp } from '../services/cdnLocalTempManager.js';
import { CDN_CONFIG } from '../config.js';
import { processZipFile } from '../services/zipProcessor.js';
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
import { exec } from 'child_process';
import { promisify } from 'util';
import { withWorkspace } from '@/server/services/core/WorkspaceService.js';

const router = Router();

const execAsync = promisify(exec);
const isWindows = process.platform === 'win32';

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
 * in-memory map + TTL. R2 lifecycle rules expire stale packs on the bucket side.
 */
const PACK_DOWNLOAD_SPACES_PREFIX = process.env.NODE_ENV === 'development' ? 'pack-downloads-dev' : 'pack-downloads';
const PACK_DOWNLOAD_MAX_SIZE_BYTES = 15 * 1024 * 1024 * 1024; // 15GB hard limit
/** Max path length for extraction (e.g. Windows MAX_PATH 260; extract folder + sep + path inside zip). */
const MAX_PATH_LENGTH = 140;

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
    error?: string;
}): Promise<void> {
    const { downloadId, cacheKey, plannedTotalLevels, processedLevels, status, currentLevel, error } =
        input;

    const percent: number | null =
        status === 'completed'
            ? 100
            : status === 'failed'
                ? null
                : packPercentFromCounts(processedLevels, plannedTotalLevels);

    const message =
        status === 'failed' && error
            ? error
            : currentLevel
                ? `Processing: ${currentLevel}`
                : undefined;

    await ingestJobProgress({
        jobId: downloadId,
        kind: 'pack_download',
        phase: status,
        percent,
        message,
        meta: {
            cacheKey,
            totalLevels: plannedTotalLevels,
            processedLevels,
            ...(currentLevel ? { currentLevel } : {})
        },
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
            env: isWindows ? undefined : { ...process.env, LC_ALL: 'C.UTF-8' },
            signal
        });
    } catch (error: any) {
        // unzip exit codes: 0=success, 1=warnings but continued, 2=corrupt, 3=severe error
        // Exit code 1 often means filename encoding warnings but extraction succeeded

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
            shellCommand: cmd,
            ...execErrorDetails(error)
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

/** Compute path length with trimmable segments (folders) capped at maxSegLen; files are included as-is. */
function pathLengthWithCap(relPath: string, trimmableSet: Set<string>, maxSegLen: number): number {
    const norm = path.win32.normalize(relPath);
    const segments = norm.split(PATH_SEP);
    let acc = '';
    let len = 0;
    for (const seg of segments) {
        acc = acc ? `${acc}${PATH_SEP}${seg}` : seg;
        const segLen = trimmableSet.has(acc) ? Math.min(seg.length, maxSegLen) : seg.length;
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

/** Returns max path length when all folder-only segment lengths are capped at maxSegLen. */
async function getMaxPathLengthWithCap(
    dir: string,
    root: string,
    folderOnlySet: Set<string>,
    maxSegLen: number
): Promise<number> {
    let maxLen = 0;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
        const fullPath = path.join(dir, e.name);
        const rel = path.relative(root, fullPath);
        const relNorm = path.win32.normalize(rel);
        const len = pathLengthWithCap(relNorm, folderOnlySet, maxSegLen);
        if (len > maxLen) maxLen = len;
        if (e.isDirectory()) {
            const subMax = await getMaxPathLengthWithCap(fullPath, root, folderOnlySet, maxSegLen);
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

/**
 * After unpack: find the deepest path (to files), identify pure folders-of-folders in it, and apply
 * a uniform ceiling to minimize the total path length (including files) so extractFolderName + sep +
 * pathInsideZip stays under MAX_PATH_LENGTH. Uses pure folders-of-folders first; if still
 * over budget, also trims level folders (containing files).
 */
async function trimRootFoldersForPathLimit(extractRoot: string, zipName: string): Promise<void> {
    const allFolders = await collectFolders(extractRoot, extractRoot);
    if (allFolders.length === 0) {
        return;
    }

    const extractFolderName = path.parse(zipName).name || 'pack';
    const pathBudget = Math.max(1, MAX_PATH_LENGTH - 1 - extractFolderName.length);

    const { maxLen } = await getMaxRelativePathAndLength(extractRoot, extractRoot);
    if (maxLen <= pathBudget) {
        return;
    }

    const pureFolderList = allFolders.filter((f) => f.isPureFolderOfFolders);
    const trimmableList =
        pureFolderList.length > 0 ? pureFolderList : allFolders;
    const trimmableSet = new Set(trimmableList.map((f) => path.win32.normalize(f.relativePath)));
    const maxNameLen = Math.max(...trimmableList.map((f) => f.name.length), 1);

    let low = 1;
    let high = maxNameLen;
    let bestCap = 1;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const simulatedMax = await getMaxPathLengthWithCap(extractRoot, extractRoot, trimmableSet, mid);
        if (simulatedMax <= pathBudget) {
            bestCap = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    let finalList = trimmableList;
    if (pureFolderList.length > 0) {
        const pureSet = new Set(pureFolderList.map((f) => path.win32.normalize(f.relativePath)));
        const afterPure = await getMaxPathLengthWithCap(extractRoot, extractRoot, pureSet, bestCap);
        if (afterPure > pathBudget && allFolders.length > pureFolderList.length) {
            const combinedSet = new Set(allFolders.map((f) => path.win32.normalize(f.relativePath)));
            let low2 = 1;
            let high2 = Math.max(...allFolders.map((f) => f.name.length), 1);
            let bestCap2 = 1;
            while (low2 <= high2) {
                const mid = Math.floor((low2 + high2) / 2);
                const sim = await getMaxPathLengthWithCap(extractRoot, extractRoot, combinedSet, mid);
                if (sim <= pathBudget) {
                    bestCap2 = mid;
                    low2 = mid + 1;
                } else {
                    high2 = mid - 1;
                }
            }
            bestCap = bestCap2;
            finalList = allFolders;
        }
    }

    const cappedNames = finalList.map((f) => {
        const capped = f.name.length > bestCap ? f.name.slice(0, bestCap) : f.name;
        return capped || 'pack';
    });

    const parentToChildren = new Map<string, { index: number; newName: string }[]>();
    for (let i = 0; i < finalList.length; i++) {
        const f = finalList[i];
        const parent = path.dirname(f.relativePath) || '';
        const arr = parentToChildren.get(parent) ?? [];
        arr.push({ index: i, newName: cappedNames[i] });
        parentToChildren.set(parent, arr);
    }

    const uniqueNewNames: string[] = [];
    for (let i = 0; i < finalList.length; i++) {
        const f = finalList[i];
        const parent = path.dirname(f.relativePath) || '';
        const siblings = parentToChildren.get(parent) ?? [];
        const sameCapped = siblings.filter((s) => s.newName === cappedNames[i]);
        const idx = sameCapped.findIndex((s) => s.index === i) + 1;
        uniqueNewNames.push(idx > 1 ? `${cappedNames[i]}_${idx}` : cappedNames[i]);
    }

    const renames: { oldPath: string; newPath: string }[] = [];
    for (let i = 0; i < finalList.length; i++) {
        const f = finalList[i];
        const newName = uniqueNewNames[i];
        if (f.name === newName) {
            continue;
        }
        const parentRel = path.dirname(f.relativePath);
        const newRel = parentRel ? path.join(parentRel, newName) : newName;
        renames.push({
            oldPath: path.join(extractRoot, f.relativePath),
            newPath: path.join(extractRoot, newRel)
        });
    }

    renames.sort((a, b) => b.oldPath.length - a.oldPath.length);
    for (const { oldPath, newPath } of renames) {
        await fs.promises.rename(oldPath, newPath);
    }
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

            await emitPackJobProgress({
                downloadId,
                cacheKey,
                plannedTotalLevels: totalLevels,
                processedLevels: context.successCount,
                status: 'zipping'
            });

            const sevenZipPath = '7z';
            let cmd: string;
            if (isWindows) {
                // -tzip: zip format, -mx=0 / -mm=Copy: store-only (fastest), -r: recurse,
                // -mcu=on: force UTF-8 filenames inside the archive.
                cmd = `cd /d "${extractRoot}" && "${sevenZipPath}" a -tzip -mx=0 -mm=Copy -r -mcu=on "${targetPath}" *`;
            } else {
                cmd = `cd "${extractRoot}" && zip -r -0 "${targetPath}" .`;
            }

            try {
                // `signal` kills the 7z/zip child process on SIGINT/SIGTERM so we don't block
                // shutdown waiting for a multi-GB archive to finish.
                await execAsync(cmd, {
                    shell: isWindows ? 'cmd.exe' : '/bin/bash',
                    maxBuffer: 1024 * 1024 * 100,
                    env: isWindows ? undefined : { ...process.env, LC_ALL: 'C.UTF-8' },
                    signal: ws.signal
                });
            } catch (error) {
                logger.error('Failed to create zip using 7z/zip', {
                    ...execErrorDetails(error),
                    shellCommand: cmd,
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
                status: 'uploading'
            });

            await spacesStorage.uploadFile(targetPath, spacesKey, 'application/zip', {
                cacheKey,
                generatedAt: new Date().toISOString(),
                successLevels: context.successCount.toString(),
                totalLevels: context.totalLevels.toString()
            });

            const responseUrl = await spacesStorage.getPresignedUrl(spacesKey);

            return {
                downloadId,
                url: responseUrl,
                zipName,
                cacheKey,
                successCount: context.successCount,
                totalLevels: context.totalLevels
            };
        });

        await emitPackJobProgress({
            downloadId,
            cacheKey,
            plannedTotalLevels: totalLevels,
            processedLevels: response.successCount,
            status: 'completed'
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
            logger.error('No level files found in metadata:', { fileId });
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

                ingestJobProgress({
                    jobId: reusedDownloadId,
                    kind: 'pack_download',
                    phase: 'completed',
                    percent: 100,
                    message: 'Cached pack ready',
                    meta: {
                        cacheKey: normalizedCacheKey,
                        totalLevels: 0,
                        processedLevels: 0,
                        reused: true
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
                    cacheKey: normalizedCacheKey
                });
            }
        } catch (error) {
            logger.warn('Failed to probe R2 for cached pack download; regenerating', {
                cacheKey: normalizedCacheKey,
                error: error instanceof Error ? error.message : String(error)
            });
        }

        // In-process coalescing: if another request is already building this same pack, await it
        // instead of kicking off a duplicate workspace + 7z run.
        let generationPromise = packGenerationPromises.get(normalizedCacheKey);
        if (!generationPromise) {
            generationPromise = (async () => {
                try {
                    return await generatePackDownloadZip(sanitizedZipName, tree, normalizedCacheKey, clientDownloadId, trimFolderNames !== false);
                } finally {
                    packGenerationPromises.delete(normalizedCacheKey);
                }
            })();
            packGenerationPromises.set(normalizedCacheKey, generationPromise);
        }

        const responsePayload = await generationPromise;
        return res.json(responsePayload);
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

// Send level upload progress update to main server
async function sendLevelUploadProgress(
    uploadId: string | undefined,
    status: 'uploading' | 'processing' | 'caching' | 'completed' | 'failed',
    progressPercent: number,
    currentStep?: string,
    error?: string
): Promise<void> {
    if (!uploadId) {
        return;
    }

    await ingestJobProgress({
        jobId: uploadId,
        kind: 'level_upload',
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
            cdnLocalTemp.cleanupFiles(req.file.path);
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

            cdnLocalTemp.cleanupFiles(req.file.path);

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
