import path from 'path';
import fs from 'fs';
import axios from 'axios';
import http from 'http';
import https from 'https';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { Readable } from 'stream';
import { emitCdnJobProgress } from '@/externalServices/cdnService/jobs/jobProgressIngest.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { CDN_CONFIG, CDN_IMMUTABLE_CACHE_CONTROL } from '@/externalServices/cdnService/config.js';
import { Request, Response, Router } from 'express';
import CdnFile from '@/models/cdn/CdnFile.js';
import crypto from 'crypto';
import { spacesStorage } from '@/externalServices/cdnService/infra/storage/spacesStorage.js';
import { LEVEL_SUPPORTED_AUDIO_EXTENSION_SET } from '@/externalServices/cdnService/constants/levelPackAudio.js';
import {
    createZip as archiveCreateZip,
    extractAll as archiveExtractAll
} from '@/externalServices/cdnService/infra/archive/archiveService.js';
import {
    PACK_DOWNLOAD_MAX_SIZE_BYTES,
    PACK_DOWNLOAD_MAX_CONCURRENT_DISK_BYTES,
    PACK_DOWNLOAD_MAX_CONCURRENT_JOBS,
    PACK_DOWNLOAD_MIN_FREE_DISK_BYTES,
    PACK_DOWNLOAD_PARALLELISM,
    PACK_DOWNLOAD_TEMP_SWEEP_MAX_AGE_MS,
    computePackDiskBudgetBytes,
} from '@/externalServices/cdnService/domain/pack/packDownloadConfig.js';
import {
    PackDiskFullError,
    PackInvalidExternalUrlError,
    PackSizeLimitExceededError,
    assertPackDiskHeadroom,
    isEnospcError,
    toPackDownloadFailure,
} from '@/externalServices/cdnService/domain/pack/packDownloadDisk.js';
import { sweepOrphanedPackDownloadArtifacts } from '@/externalServices/cdnService/domain/pack/packDownloadTempSweep.js';
import { createAsyncPool } from '@/misc/utils/asyncPool.js';

const router = Router();

const PACK_DOWNLOAD_DIR = path.join(CDN_CONFIG.pack_root, 'pack-downloads');
const PACK_DOWNLOAD_TEMP_DIR = path.join(PACK_DOWNLOAD_DIR, 'temp');
const PACK_DOWNLOAD_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const PACK_DOWNLOAD_CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
/** Min interval between pack upload progress broadcasts (R2 multipart fires often). */
const PACK_UPLOAD_PROGRESS_THROTTLE_MS = 400;
const PACK_DOWNLOAD_SPACES_PREFIX = process.env.NODE_ENV === 'development' ? 'pack-downloads-dev' : 'pack-downloads';
const CDN_FILE_PACK_ATTRIBUTES = ['id', 'type', 'metadata'] as const;
const packLevelWorkPool = createAsyncPool(PACK_DOWNLOAD_PARALLELISM);
const EXTERNAL_URL_MAX_LENGTH = 2048;
const EXTERNAL_URL_HEAD_TIMEOUT_MS = 10_000;
const EXTERNAL_URL_DOWNLOAD_TIMEOUT_MS = 30_000;
const EXTERNAL_LEVEL_ZIP_MAX_BYTES = CDN_CONFIG.maxFileSize;
const ZIP_LOCAL_FILE_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
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
    /** Machine-readable failure code for the main API job `meta.code`. */
    errorCode?: string;
    /** Set when status is completed — merged into main API job `meta` for the client download step. */
    packUrl?: string;
    packZipName?: string;
    packExpiresAt?: string;
}

const packDownloadProgress = new Map<string, PackDownloadProgress>();

// Queue system for managing concurrent pack generations (disk budget + job count)
interface ActiveGeneration {
    cacheKey: string;
    estimatedSize: number;
    diskBudgetBytes: number;
}

interface QueuedGeneration {
    cacheKey: string;
    estimatedSize: number;
    diskBudgetBytes: number;
    resolve: () => void;
    reject: (error: Error) => void;
}

const activeGenerations = new Map<string, ActiveGeneration>();
const generationQueue: QueuedGeneration[] = [];

function getTotalActiveDiskBudget(): number {
    let total = 0;
    for (const gen of activeGenerations.values()) {
        total += gen.diskBudgetBytes;
    }
    return total;
}

function canStartGeneration(diskBudgetBytes: number): boolean {
    if (activeGenerations.size >= PACK_DOWNLOAD_MAX_CONCURRENT_JOBS) {
        return false;
    }
    return getTotalActiveDiskBudget() + diskBudgetBytes <= PACK_DOWNLOAD_MAX_CONCURRENT_DISK_BYTES;
}

async function registerGeneration(
    estimatedSize: number,
    diskBudgetBytes: number,
    cacheKey: string,
): Promise<void> {
    await assertPackDiskHeadroom(
        PACK_DOWNLOAD_DIR,
        diskBudgetBytes,
        PACK_DOWNLOAD_MIN_FREE_DISK_BYTES,
    );

    activeGenerations.set(cacheKey, {
        cacheKey,
        estimatedSize,
        diskBudgetBytes,
    });

    logger.debug('Pack generation registered', {
        cacheKey,
        estimatedSize,
        estimatedSizeGB: (estimatedSize / (1024 * 1024 * 1024)).toFixed(2),
        diskBudgetBytes,
        diskBudgetGB: (diskBudgetBytes / (1024 * 1024 * 1024)).toFixed(2),
        activeJobs: activeGenerations.size,
        activeDiskBudgetGB: (getTotalActiveDiskBudget() / (1024 * 1024 * 1024)).toFixed(2),
    });
}

async function waitForSpace(estimatedSize: number, cacheKey: string): Promise<void> {
    if (activeGenerations.has(cacheKey)) {
        return;
    }

    const diskBudgetBytes = computePackDiskBudgetBytes(estimatedSize);

    if (canStartGeneration(diskBudgetBytes)) {
        await registerGeneration(estimatedSize, diskBudgetBytes, cacheKey);
        return;
    }

    logger.debug('Pack generation queued (disk budget or job limit)', {
        cacheKey,
        estimatedSize,
        diskBudgetBytes,
        diskBudgetGB: (diskBudgetBytes / (1024 * 1024 * 1024)).toFixed(2),
        activeJobs: activeGenerations.size,
        maxJobs: PACK_DOWNLOAD_MAX_CONCURRENT_JOBS,
        activeDiskBudgetGB: (getTotalActiveDiskBudget() / (1024 * 1024 * 1024)).toFixed(2),
        maxDiskBudgetGB: (PACK_DOWNLOAD_MAX_CONCURRENT_DISK_BYTES / (1024 * 1024 * 1024)).toFixed(2),
        queueLength: generationQueue.length,
    });

    return new Promise<void>((resolve, reject) => {
        generationQueue.push({
            cacheKey,
            estimatedSize,
            diskBudgetBytes,
            resolve,
            reject,
        });
    });
}

function unregisterGeneration(cacheKey: string): void {
    const removed = activeGenerations.delete(cacheKey);
    if (!removed) {
        return;
    }

    logger.debug('Pack generation completed, processing queue', {
        cacheKey,
        activeJobs: activeGenerations.size,
        activeDiskBudgetGB: (getTotalActiveDiskBudget() / (1024 * 1024 * 1024)).toFixed(2),
        queueLength: generationQueue.length,
    });

    void drainGenerationQueue();
}

async function drainGenerationQueue(): Promise<void> {
    while (generationQueue.length > 0) {
        const queued = generationQueue[0];

        if (activeGenerations.has(queued.cacheKey)) {
            generationQueue.shift();
            queued.resolve();
            continue;
        }

        if (!canStartGeneration(queued.diskBudgetBytes)) {
            break;
        }

        generationQueue.shift();

        try {
            await registerGeneration(queued.estimatedSize, queued.diskBudgetBytes, queued.cacheKey);
            logger.debug('Pack generation dequeued and started', {
                cacheKey: queued.cacheKey,
                diskBudgetGB: (queued.diskBudgetBytes / (1024 * 1024 * 1024)).toFixed(2),
                remainingQueueLength: generationQueue.length,
            });
            queued.resolve();
        } catch (error) {
            queued.reject(error instanceof Error ? error : new Error(String(error)));
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

function parseIpv4(address: string): number[] | null {
    const parts = address.split('.');
    if (parts.length !== 4) {
        return null;
    }
    const bytes = parts.map((part) => Number(part));
    if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
        return null;
    }
    return bytes;
}

function extractMappedIpv4(address: string): string | null {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) {
        const mapped = normalized.slice('::ffff:'.length);
        return parseIpv4(mapped) ? mapped : null;
    }
    return null;
}

function isBlockedIpv4(address: string): boolean {
    const bytes = parseIpv4(address);
    if (!bytes) {
        return true;
    }

    const [a, b] = bytes;
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 0) ||
        (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 198 && b === 51) ||
        (a === 203 && b === 0) ||
        a >= 224
    );
}

function isBlockedIpAddress(address: string): boolean {
    const mappedIpv4 = extractMappedIpv4(address);
    if (mappedIpv4) {
        return isBlockedIpv4(mappedIpv4);
    }

    const family = isIP(address);
    if (family === 4) {
        return isBlockedIpv4(address);
    }
    if (family !== 6) {
        return true;
    }

    const normalized = address.toLowerCase();
    return (
        normalized === '::' ||
        normalized === '::1' ||
        normalized.startsWith('fc') ||
        normalized.startsWith('fd') ||
        normalized.startsWith('fe8') ||
        normalized.startsWith('fe9') ||
        normalized.startsWith('fea') ||
        normalized.startsWith('feb') ||
        normalized.startsWith('ff') ||
        normalized.startsWith('2001:db8:')
    );
}

function parseSafeExternalUrl(sourceUrl: string): URL {
    const trimmed = sourceUrl.trim();
    if (trimmed.length === 0 || trimmed.length > EXTERNAL_URL_MAX_LENGTH) {
        throw new Error('External URL is empty or too long');
    }

    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('External URL must use http or https');
    }
    if (url.username || url.password) {
        throw new Error('External URL credentials are not allowed');
    }
    if (url.port && url.port !== '80' && url.port !== '443') {
        throw new Error('External URL custom ports are not allowed');
    }

    const host = url.hostname.toLowerCase();
    if (
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host.endsWith('.local') ||
        (!host.includes('.') && !isIP(host))
    ) {
        throw new Error('External URL host is not allowed');
    }
    if (isIP(host) && isBlockedIpAddress(host)) {
        throw new Error('External URL IP address is not allowed');
    }

    return url;
}

async function assertExternalHostnameIsPublic(hostname: string): Promise<void> {
    const records = await lookup(hostname, { all: true, verbatim: false });
    if (records.length === 0) {
        throw new Error('External URL host did not resolve');
    }
    for (const record of records) {
        if (isBlockedIpAddress(record.address)) {
            throw new Error('External URL resolves to a blocked address');
        }
    }
}

async function validateExternalUrl(sourceUrl: string): Promise<URL> {
    const url = parseSafeExternalUrl(sourceUrl);
    await assertExternalHostnameIsPublic(url.hostname);
    return url;
}

const validatedLookup = (
    hostname: string,
    options: unknown,
    callback: (err: NodeJS.ErrnoException | null, address: any, family?: number) => void
) => {
    void (async () => {
        try {
            const lookupOptions = typeof options === 'object' && options !== null ? options as { all?: boolean; family?: number } : {};
            const records = await lookup(hostname, {
                all: Boolean(lookupOptions.all),
                family: lookupOptions.family,
                verbatim: false,
            } as any);
            const resolvedRecords = Array.isArray(records) ? records : [records];
            for (const record of resolvedRecords) {
                if (isBlockedIpAddress(record.address)) {
                    throw new Error('External URL resolved to a blocked address during request');
                }
            }
            if (lookupOptions.all) {
                callback(null, resolvedRecords);
                return;
            }
            const first = resolvedRecords[0];
            callback(null, first.address, first.family);
        } catch (error) {
            callback(error as NodeJS.ErrnoException, null);
        }
    })();
};

const externalHttpAgent = new http.Agent({ keepAlive: false, lookup: validatedLookup });
const externalHttpsAgent = new https.Agent({ keepAlive: false, lookup: validatedLookup });

function validateRedirectTarget(options: Record<string, any>): void {
    const protocol = typeof options.protocol === 'string' ? options.protocol : '';
    const hostname = typeof options.hostname === 'string' ? options.hostname : '';
    const hostForUrl = isIP(hostname) === 6 && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
    const port = options.port ? `:${options.port}` : '';
    if (options.auth) {
        throw new Error('External URL redirect credentials are not allowed');
    }
    parseSafeExternalUrl(`${protocol}//${hostForUrl}${port}${options.path ?? '/'}`);
}

function getContentLengthBytes(headers: Record<string, any>): number | null {
    const raw = headers['content-length'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === undefined || value === null || value === '') {
        return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function assertIdentityTransferEncoding(headers: Record<string, any>): void {
    const raw = headers['content-encoding'];
    const encodings = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const blocked = encodings
        .flatMap((encoding) => String(encoding).split(','))
        .map((encoding) => encoding.trim().toLowerCase())
        .filter((encoding) => encoding.length > 0 && encoding !== 'identity');

    if (blocked.length > 0) {
        throw new Error(`Compressed external URL responses are not allowed: ${blocked.join(', ')}`);
    }
}

function isZipLocalFileHeader(bytes: Buffer): boolean {
    return bytes.length >= ZIP_LOCAL_FILE_HEADER.length && bytes.subarray(0, ZIP_LOCAL_FILE_HEADER.length).equals(ZIP_LOCAL_FILE_HEADER);
}

async function streamValidatedZipToDisk(stream: Readable, targetPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(targetPath, { flags: 'wx' });
        let settled = false;
        let totalBytes = 0;
        let prefix = Buffer.alloc(0);
        let magicValidated = false;

        const fail = (error: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            stream.destroy(error);
            writeStream.destroy(error);
            reject(error);
        };

        stream.on('data', (chunk: Buffer) => {
            totalBytes += chunk.length;
            if (totalBytes > EXTERNAL_LEVEL_ZIP_MAX_BYTES) {
                fail(new Error('External ZIP exceeds maximum allowed size'));
                return;
            }

            if (!magicValidated) {
                prefix = Buffer.concat([prefix, chunk]).subarray(0, ZIP_LOCAL_FILE_HEADER.length);
                if (prefix.length >= ZIP_LOCAL_FILE_HEADER.length) {
                    if (!isZipLocalFileHeader(prefix)) {
                        fail(new Error('External file is not a valid ZIP archive'));
                        return;
                    }
                    magicValidated = true;
                }
            }
        });

        writeStream.on('finish', () => {
            if (settled) {
                return;
            }
            if (!magicValidated) {
                fail(new Error('External ZIP is too small or missing a ZIP header'));
                return;
            }
            settled = true;
            resolve();
        });
        stream.on('error', fail);
        writeStream.on('error', fail);
        stream.pipe(writeStream);
    });
}

async function downloadExternalZipToDisk(sourceUrl: string, targetPath: string): Promise<Record<string, any>> {
    const url = await validateExternalUrl(sourceUrl);
    const response = await axios.get(url.href, {
        responseType: 'stream',
        decompress: false,
        timeout: EXTERNAL_URL_DOWNLOAD_TIMEOUT_MS,
        maxRedirects: 5,
        httpAgent: externalHttpAgent,
        httpsAgent: externalHttpsAgent,
        beforeRedirect: validateRedirectTarget,
        validateStatus: (status) => status >= 200 && status < 300,
        headers: {
            'Accept': 'application/zip, application/octet-stream;q=0.9, */*;q=0.1',
            'Accept-Encoding': 'identity',
        },
    });

    assertIdentityTransferEncoding(response.headers);
    const contentLength = getContentLengthBytes(response.headers);
    if (contentLength !== null && contentLength > EXTERNAL_LEVEL_ZIP_MAX_BYTES) {
        throw new Error('External ZIP content-length exceeds maximum allowed size');
    }

    await streamValidatedZipToDisk(response.data as Readable, targetPath);
    return response.headers;
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
    await sweepOrphanedPackDownloadArtifacts(
        PACK_DOWNLOAD_DIR,
        PACK_DOWNLOAD_TEMP_DIR,
        PACK_DOWNLOAD_TEMP_SWEEP_MAX_AGE_MS,
    );
}

await initializePackDownloadStorage();
await cleanupPackDownloadSpaces();
setInterval(() => {
    cleanupExpiredDownloads().catch(error => {
        logger.error('Failed to cleanup expired pack downloads:', {
            error: error instanceof Error ? error.message : String(error)
        });
    });
    sweepOrphanedPackDownloadArtifacts(
        PACK_DOWNLOAD_DIR,
        PACK_DOWNLOAD_TEMP_DIR,
        PACK_DOWNLOAD_TEMP_SWEEP_MAX_AGE_MS,
    ).catch(error => {
        logger.error('Failed to sweep orphaned pack download temp dirs:', {
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

    // Route through archiveService.extractAll so we get the same ZIP filename code-page
    // detection (`-mcp=<N>`) the ingest path uses. Without this, ZIPs whose entries pre-date
    // GPF bit 11 (Windows Explorer's built-in zipper on Japanese / Chinese / Korean systems)
    // would produce `ܡ�������.adofai`-style mojibake when re-packed for pack downloads.
    try {
        await archiveExtractAll(zipPath, extractTo);
        return;
    } catch (error) {
        let extractedEntries: fs.Dirent[] = [];
        try {
            extractedEntries = await fs.promises.readdir(extractTo, { withFileTypes: true });
        } catch {
            /* extraction directory empty / missing — handled below */
        }
        if (extractedEntries.length > 0) {
            // Partial success (e.g. 7-Zip warning); the caller treats whatever made it to disk as good.
            return;
        }

        throw error;
    }
}

async function addLevelFromCdn(node: PackDownloadNode, parentPath: string, context: PackGenerationContext): Promise<{ folderName: string; success: boolean; }> {
    if (!node.fileId) {
        return { folderName: parentPath, success: false };
    }

    try {
        const cdnFile = await CdnFile.findByPk(node.fileId, {
            attributes: [...CDN_FILE_PACK_ATTRIBUTES],
        });
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
        const responseHeaders = await downloadExternalZipToDisk(node.sourceUrl, tempZipPath);
        logger.debug('Successfully downloaded validated zip file from URL to temp location', {
            tempZipPath,
            sourceUrl: node.sourceUrl,
            fileExists: fs.existsSync(tempZipPath)
        });

        const defaultName = node.name || `Level-${node.levelId ?? 'unknown'}`;
        const dispositionFilename = getFilenameFromDisposition(responseHeaders['content-disposition']);
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
            await Promise.all(
                children.map((child) =>
                    packLevelWorkPool(() => processPackNode(child, folderPath, context)),
                ),
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

        // Final pack archive: 7-Zip subprocess only (same implementation as ingest `createZip`).
        try {
            await archiveCreateZip(extractRoot, targetPath);
        } catch (error) {
            if (isEnospcError(error)) {
                throw new PackDiskFullError(
                    'Not enough temporary disk space while creating the pack archive',
                );
            }
            logger.error('Failed to create pack zip via 7-Zip', {
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
        const failure = toPackDownloadFailure(error);

        if (downloadId) {
            await updateProgress(downloadId, cacheKey, {
                status: 'failed',
                error: failure.message,
                errorCode: failure.code,
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

async function validateExternalUrlsInPackTree(node: PackDownloadNode): Promise<void> {
    if (node.type === 'folder') {
        if (!Array.isArray(node.children)) {
            return;
        }
        await Promise.all(node.children.map((child) => validateExternalUrlsInPackTree(child)));
        return;
    }

    if (node.sourceUrl) {
        await validateExternalUrl(node.sourceUrl);
    }
}

async function getFileSizeFromCdn(fileId: string): Promise<number | null> {
    try {
        const cdnFile = await CdnFile.findByPk(fileId, {
            attributes: [...CDN_FILE_PACK_ATTRIBUTES],
        });
        if (!cdnFile || cdnFile.type !== 'LEVELZIP' || !cdnFile.metadata) {
            return null;
        }

        const metadata = cdnFile.metadata as any;
        const originalZip = metadata.originalZip;
        if (!originalZip?.path) {
            return null;
        }

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
        const url = await validateExternalUrl(sourceUrl);
        const response = await axios.head(url.href, {
            timeout: EXTERNAL_URL_HEAD_TIMEOUT_MS,
            maxRedirects: 5,
            decompress: false,
            httpAgent: externalHttpAgent,
            httpsAgent: externalHttpsAgent,
            beforeRedirect: validateRedirectTarget,
            headers: {
                'Accept': 'application/zip, application/octet-stream;q=0.9, */*;q=0.1',
                'Accept-Encoding': 'identity',
            },
            validateStatus: (status) => status >= 200 && status < 400
        });
        assertIdentityTransferEncoding(response.headers);

        const size = getContentLengthBytes(response.headers);
        if (size !== null && size > 0 && size <= EXTERNAL_LEVEL_ZIP_MAX_BYTES) {
            return size;
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
                await Promise.all(
                    node.children.map((child) =>
                        packLevelWorkPool(() => traverseNode(child)),
                    ),
                );
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
                // If we can't determine size, use a conservative estimate aligned with max parseable chart size
                // This ensures we don't allow unlimited growth if size detection fails
                totalSize += 10 * 1024 * 1024; // 10MB estimate
            }
        }
    }

    await traverseNode(tree);
    return { totalSize, estimatedCount, failedCount };
}

function formatFinalZipName(zipName: string, packCode?: string | null): string {
    let finalZipName = zipName.slice(0, 40);
    if (packCode && typeof packCode === 'string' && packCode.trim().length > 0) {
        if (!zipName.includes(` - ${packCode}`)) {
            finalZipName = `${zipName} - ${packCode}`;
        }
    }
    return finalZipName;
}

function resolveNormalizedCacheKey(
    cacheKey: unknown,
    finalZipName: string,
    tree: PackDownloadNode,
): string {
    if (typeof cacheKey === 'string' && cacheKey.length > 0) {
        return cacheKey;
    }
    return crypto.createHash('sha256').update(JSON.stringify({ zipName: finalZipName, tree })).digest('hex');
}

function initPackJobProgress(downloadId: string, cacheKey: string): PackDownloadProgress {
    const initial: PackDownloadProgress = {
        downloadId,
        cacheKey,
        status: 'pending',
        totalLevels: 0,
        processedLevels: 0,
        currentLevel: 'Request received, preparing pack…',
        startedAt: Date.now(),
        lastUpdated: Date.now(),
    };
    packDownloadProgress.set(downloadId, initial);
    return initial;
}

async function failPackJob(
    downloadId: string,
    cacheKey: string,
    failure: { message: string; code: string },
): Promise<void> {
    const snap = packDownloadProgress.get(downloadId);
    if (snap?.status === 'failed') {
        return;
    }
    const failed: PackDownloadProgress = {
        downloadId,
        cacheKey,
        status: 'failed',
        totalLevels: snap?.totalLevels ?? 0,
        processedLevels: snap?.processedLevels ?? 0,
        startedAt: snap?.startedAt ?? Date.now(),
        lastUpdated: Date.now(),
        error: failure.message,
        errorCode: failure.code,
    };
    packDownloadProgress.set(downloadId, failed);
    await broadcastPackJobProgress(failed);
}

async function tryCompleteFromPackCache(
    normalizedCacheKey: string,
    progressJobId: string,
): Promise<PackDownloadResponse | null> {
    const existingDownloadId = packCacheIndex.get(normalizedCacheKey);
    if (!existingDownloadId) {
        return null;
    }

    const entry = packDownloadEntries.get(existingDownloadId);
    if (!entry || entry.expiresAt <= Date.now()) {
        packCacheIndex.delete(normalizedCacheKey);
        if (entry) {
            if (entry.spacesKey) {
                spacesStorage.deleteFile(entry.spacesKey).catch((error) => {
                    logger.warn('Failed to delete stale pack download from Spaces', {
                        downloadId: existingDownloadId,
                        spacesKey: entry.spacesKey,
                        error: error instanceof Error ? error.message : String(error),
                    });
                });
            }
            if (entry.filePath && fs.existsSync(entry.filePath)) {
                fs.promises.rm(entry.filePath, { force: true }).catch(() => undefined);
            }
            packDownloadEntries.delete(existingDownloadId);
        }
        return null;
    }

    try {
        let url: string | null = null;
        if (entry.spacesKey) {
            url = await spacesStorage.getPresignedUrl(entry.spacesKey);
        } else if (entry.filePath && fs.existsSync(entry.filePath)) {
            url = `${CDN_CONFIG.baseUrl}/zips/packs/downloads/${existingDownloadId}`;
        }

        if (!url) {
            return null;
        }

        const cachedProgress: PackDownloadProgress = {
            downloadId: progressJobId,
            cacheKey: entry.cacheKey,
            status: 'completed',
            totalLevels: 0,
            processedLevels: 0,
            startedAt: Date.now(),
            lastUpdated: Date.now(),
            packUrl: url,
            packZipName: entry.zipName,
            packExpiresAt: new Date(entry.expiresAt).toISOString(),
        };
        packDownloadProgress.set(progressJobId, cachedProgress);
        await broadcastPackJobProgress(cachedProgress);

        return {
            downloadId: existingDownloadId,
            url,
            expiresAt: new Date(entry.expiresAt).toISOString(),
            zipName: entry.zipName,
            cacheKey: entry.cacheKey,
        };
    } catch (error) {
        logger.error('Failed to reuse existing pack download cache entry:', {
            cacheKey: normalizedCacheKey,
            downloadId: existingDownloadId,
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}

type RunPackDownloadJobParams = {
    trimmedDownloadId: string;
    normalizedCacheKey: string;
    sanitizedZipName: string;
    tree: PackDownloadNode;
    trimFolderNames: boolean;
};

async function runPackDownloadJob(params: RunPackDownloadJobParams): Promise<PackDownloadResponse> {
    const { trimmedDownloadId, normalizedCacheKey, sanitizedZipName, tree, trimFolderNames } = params;

    try {
        await updateProgress(trimmedDownloadId, normalizedCacheKey, {
            currentLevel: 'Validating pack…',
        });
        try {
            await validateExternalUrlsInPackTree(tree);
        } catch (error) {
            throw new PackInvalidExternalUrlError(
                error instanceof Error ? error.message : 'Pack contains an unsafe external URL',
            );
        }

        await updateProgress(trimmedDownloadId, normalizedCacheKey, {
            currentLevel: 'Estimating download size…',
        });
        logger.debug('Estimating total zip size for pack download', { zipName: sanitizedZipName });
        const sizeEstimate = await estimateTotalZipSize(tree);

        if (sizeEstimate.totalSize > PACK_DOWNLOAD_MAX_SIZE_BYTES) {
            const sizeGB = (sizeEstimate.totalSize / (1024 * 1024 * 1024)).toFixed(2);
            const maxGB = (PACK_DOWNLOAD_MAX_SIZE_BYTES / (1024 * 1024 * 1024)).toFixed(0);
            throw new PackSizeLimitExceededError(
                `Pack download size exceeds maximum limit of ${maxGB}GB (estimated ${sizeGB}GB)`,
            );
        }

        logger.debug('Pack download size estimate within limits', {
            estimatedSize: sizeEstimate.totalSize,
            estimatedSizeGB: (sizeEstimate.totalSize / (1024 * 1024 * 1024)).toFixed(2),
            estimatedCount: sizeEstimate.estimatedCount,
            failedCount: sizeEstimate.failedCount,
        });

        const diskBudgetBytes = computePackDiskBudgetBytes(sizeEstimate.totalSize);
        await updateProgress(trimmedDownloadId, normalizedCacheKey, {
            currentLevel: 'Checking server capacity…',
        });
        await assertPackDiskHeadroom(
            PACK_DOWNLOAD_DIR,
            diskBudgetBytes,
            PACK_DOWNLOAD_MIN_FREE_DISK_BYTES,
        );

        await updateProgress(trimmedDownloadId, normalizedCacheKey, {
            currentLevel: 'Checking cache…',
        });
        const cached = await tryCompleteFromPackCache(normalizedCacheKey, trimmedDownloadId);
        if (cached) {
            return cached;
        }

        await waitForSpace(sizeEstimate.totalSize, normalizedCacheKey);
        return await generatePackDownloadZip(
            sanitizedZipName,
            tree,
            normalizedCacheKey,
            trimmedDownloadId,
            trimFolderNames,
        );
    } catch (error) {
        const failure = toPackDownloadFailure(error);
        await failPackJob(trimmedDownloadId, normalizedCacheKey, failure);
        throw error;
    } finally {
        unregisterGeneration(normalizedCacheKey);
        packGenerationPromises.delete(normalizedCacheKey);
        packGenerationJobSubscribers.delete(normalizedCacheKey);
        inFlightPackPrimaryJobId.delete(normalizedCacheKey);
    }
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
        const finalZipName = formatFinalZipName(zipName, packCode);
        const normalizedCacheKey = resolveNormalizedCacheKey(cacheKey, finalZipName, tree);
        const sanitizedZipName = sanitizePathSegment(finalZipName);
        const trimFolderNamesFlag = trimFolderNames !== false;

        if (!packGenerationPromises.has(normalizedCacheKey)) {
            inFlightPackPrimaryJobId.set(normalizedCacheKey, trimmedDownloadId);
            packGenerationJobSubscribers.set(normalizedCacheKey, new Set([trimmedDownloadId]));

            const pendingProgress = initPackJobProgress(trimmedDownloadId, normalizedCacheKey);
            void broadcastPackJobProgress(pendingProgress);

            const generationPromise = runPackDownloadJob({
                trimmedDownloadId,
                normalizedCacheKey,
                sanitizedZipName,
                tree,
                trimFolderNames: trimFolderNamesFlag,
            });

            packGenerationPromises.set(normalizedCacheKey, generationPromise);
            generationPromise.catch((err) => {
                const failure = toPackDownloadFailure(err);
                logger.error('Pack generation failed (background)', {
                    cacheKey: normalizedCacheKey,
                    downloadId: trimmedDownloadId,
                    code: failure.code,
                    error: failure.message,
                });
            });
        } else {
            let subs = packGenerationJobSubscribers.get(normalizedCacheKey);
            if (!subs) {
                subs = new Set<string>();
                packGenerationJobSubscribers.set(normalizedCacheKey, subs);
            }
            subs.add(trimmedDownloadId);

            if (!packDownloadProgress.has(trimmedDownloadId)) {
                const pendingProgress = initPackJobProgress(trimmedDownloadId, normalizedCacheKey);
                void broadcastPackJobProgress(pendingProgress);
            }

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
            received: true,
            started: true,
            zipName: sanitizedZipName,
            cacheKey: normalizedCacheKey,
        });
    } catch (error) {
        logger.error('Failed to accept pack download request', {
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
