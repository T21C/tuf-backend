import fs from 'fs';
import path from 'path';
import CdnFile from '@/models/cdn/CdnFile.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { cdnLocalTemp } from './cdnLocalTempManager.js';
import { spacesStorage } from './spacesStorage.js';
import LevelDict from 'adofai-lib';
import { levelCacheService, SAFE_TO_PARSE_VERSION } from './levelCacheService.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
import { Transaction } from 'sequelize';
import {
    listEntries as archiveListEntries,
    extractLevelPackPayload as archiveExtractLevelPackPayload,
    createZipFromFiles as archiveCreateZipFromFiles,
    detectArchiveFormat,
    getArchiveExtension,
    getArchiveMimeType,
    type ArchiveEntry as ServiceArchiveEntry
} from './archiveService.js';
import { withWorkspace } from '@/server/services/core/WorkspaceService.js';

const cdnSequelize = getSequelizeForModelGroup('cdn');
import { safeTransactionRollback } from '@/misc/utils/Utility.js';

/** Max level file size (bytes) to parse with LevelDict. Node string limit is ~0x1fffffe8 (~512MB); use 400MB to stay safe. */
const MAX_LEVEL_FILE_SIZE_FOR_PARSE = 400 * 1024 * 1024;

type ZipEntry = ServiceArchiveEntry;

function normalizeRelativePath(relativePath: string): string {
    return relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

function toCopyRelativePath(relativePath: string): string {
    const normalized = normalizeRelativePath(relativePath);
    const parsed = path.posix.parse(normalized);
    return path.posix.join(parsed.dir, `${parsed.name}.copy`);
}

async function extractArchiveEntries(archiveFilePath: string, signal?: AbortSignal): Promise<ZipEntry[]> {
    const entries = await archiveListEntries(archiveFilePath, signal);

    logger.debug('Listed archive entries:', {
        archiveFilePath,
        entryCount: entries.length,
        entries: entries.map(entry => ({
            name: entry.name,
            size: entry.size,
            isDirectory: entry.isDirectory
        }))
    });

    return entries;
}

type ProgressCallback = (status: 'uploading' | 'processing' | 'caching' | 'failed', progressPercent: number, currentStep?: string) => void | Promise<void>;

export async function processArchiveFile(
    archiveFilePath: string,
    archiveFileId: string,
    originalFilename: string,
    onProgress?: ProgressCallback
): Promise<void> {
    // All on-disk staging for this ingest lives inside a workspace under
    // WORKSPACE_ROOT/zip-processor/<archiveFileId>/. The workspace's `finally`
    // removes the dir on success, throw, or shutdown abort, and any orphans
    // left by SIGKILL get cleaned up by `sweepWorkspaceRootOnBoot()` next start.
    return withWorkspace(
        'zip-processor',
        (ws) => processArchiveFileInWorkspace(ws, archiveFilePath, archiveFileId, originalFilename, onProgress),
        { key: archiveFileId }
    );
}

async function processArchiveFileInWorkspace(
    ws: { dir: string; signal: AbortSignal },
    archiveFilePath: string,
    archiveFileId: string,
    originalFilename: string,
    onProgress?: ProgressCallback
): Promise<void> {
    let transaction: Transaction | undefined;
    /** Workspace dir; auto-removed by {@link withWorkspace} on success/throw/abort. */
    const permanentDir = ws.dir;
    // Preloaded LevelDict for the eventual cache target.
    // When available, we can populate cache without re-downloading the target from Spaces.
    let selectedPreloadedTargetLevelData: LevelDict | null = null;
    let preloadedNonBackupLevelData: LevelDict | null = null;
    let preloadedBackupLevelData: LevelDict | null = null;
    let bestNonBackupSize = -1;
    let bestBackupSize = -1;

    // Detect format up-front so we know which extension to preserve in storage and metadata.
    const detectedFormat = detectArchiveFormat(originalFilename) || detectArchiveFormat(archiveFilePath) || 'zip';
    const archiveContentType = getArchiveMimeType(detectedFormat);

    logger.debug('Starting archive file processing:', {
        archiveFilePath,
        archiveFileId,
        originalFilename,
        detectedFormat,
        permanentDir,
        fileSize: (await fs.promises.stat(archiveFilePath)).size
    });

    const sendProgress = async (status: 'uploading' | 'processing' | 'caching' | 'failed', progressPercent: number, currentStep?: string) => {
        if (onProgress) {
            await onProgress(status, progressPercent, currentStep);
        }
    };

    try {
        await sendProgress('processing', 10, 'Listing archive entries');
        const archiveEntries = await extractArchiveEntries(archiveFilePath, ws.signal);
        const levelFiles: { [key: string]: any } = {};
        const allLevelFiles: Array<{
            name: string;
            relativePath: string;
            path: string;
            sourceCopyPath?: string;
            sourceCopyRelativePath?: string;
            sourceCopyStorageType?: string;
            size: number;
            hasYouTubeStream?: boolean;
            songFilename?: string;
            oversizedUnparsed?: boolean;
        }> = [];
        const songFiles: { [key: string]: any } = {};

        logger.debug('Processing archive file in workspace:', {
            permanentDir,
            fileId: archiveFileId,
            format: detectedFormat,
            totalEntries: archiveEntries.length,
            totalSize: archiveEntries.reduce((sum, entry) => sum + entry.size, 0)
        });

        // originalFilename is already NFC-normalised and sanitised upstream in UploadSessionService.
        const finalArchiveName = originalFilename;
        logger.debug('Using original archive name:', {
            finalArchiveName,
            format: detectedFormat
        });

        // Store the original archive file with its original name
        const originalArchiveDiskPath = path.join(permanentDir, finalArchiveName);
        await fs.promises.copyFile(archiveFilePath, originalArchiveDiskPath);
        const originalArchiveSize = (await fs.promises.stat(originalArchiveDiskPath)).size;
        logger.debug('Stored original archive file:', {
            originalArchiveDiskPath,
            finalArchiveName,
            size: originalArchiveSize,
            permanentDir
        });

        // Bulk-extract `.adofai` + audio (see archiveService.extractLevelPackPayload); fall back to full extract
        // if filtered extraction fails (e.g. solid RAR5) or any listed `.adofai` path is missing (partial extract).
        const extractRoot = path.join(permanentDir, '.extracted');
        const levelEntries = archiveEntries.filter(entry => !entry.isDirectory && entry.relativePath.toLowerCase().endsWith('.adofai'));
        const requiredLevelPaths = levelEntries.map(entry => normalizeRelativePath(entry.relativePath));
        await sendProgress('processing', 13, 'Extracting level and song files from archive');
        await archiveExtractLevelPackPayload(archiveFilePath, extractRoot, ws.signal, {
            requiredRelativePaths: requiredLevelPaths
        });

        // First pass: collect all level files (metadata paths come from listing; bytes from `extractRoot`)
        await sendProgress('processing', 15, 'Processing level files');
        let totalLevelSize = 0;
        let processedLevels = 0;
        for (const entry of levelEntries) {
            const normalizedRelativePath = normalizeRelativePath(entry.relativePath);
            const tempPath = path.join(extractRoot, normalizedRelativePath);

            if (!fs.existsSync(tempPath)) {
                throw new Error(
                    `Level file missing after archive extraction: ${normalizedRelativePath} (expected at ${tempPath}). ` +
                        'The archive listing included this path but it was not extracted.'
                );
            }

            try {
                const levelFilename = path.basename(entry.relativePath);
                const sourceCopyRelativePath = toCopyRelativePath(normalizedRelativePath);
                const tooLargeToParse = entry.size > MAX_LEVEL_FILE_SIZE_FOR_PARSE;

                let levelFile: {
                    name: string;
                    relativePath: string;
                    path: string;
                    sourceCopyPath?: string;
                    sourceCopyRelativePath?: string;
                    sourceCopyStorageType?: string;
                    size: number;
                    hasYouTubeStream?: boolean;
                    songFilename?: string;
                    oversizedUnparsed?: boolean;
                    artist?: unknown;
                    song?: unknown;
                    author?: unknown;
                    difficulty?: unknown;
                    bpm?: unknown;
                };

                if (tooLargeToParse) {
                    logger.debug('Skipping LevelDict parse for oversized level file (would exceed Node string limit):', {
                        name: levelFilename,
                        size: entry.size,
                        maxParseSize: MAX_LEVEL_FILE_SIZE_FOR_PARSE
                    });
                    levelFile = {
                        name: levelFilename,
                        relativePath: normalizedRelativePath,
                        path: tempPath,
                        sourceCopyRelativePath,
                        size: entry.size,
                        hasYouTubeStream: false,
                        songFilename: undefined,
                        oversizedUnparsed: true
                    };
                } else {
                    const levelDict = new LevelDict(tempPath);
                    const isBackup = levelFilename.toLowerCase() === 'backup.adofai';
                    if (isBackup) {
                        if (entry.size > bestBackupSize) {
                            bestBackupSize = entry.size;
                            preloadedBackupLevelData = levelDict;
                        }
                    } else {
                        if (entry.size > bestNonBackupSize) {
                            bestNonBackupSize = entry.size;
                            preloadedNonBackupLevelData = levelDict;
                        }
                    }
                    levelFile = {
                        name: levelFilename,
                        relativePath: normalizedRelativePath,
                        path: tempPath, // Keep temp path for now, will be uploaded later
                        sourceCopyRelativePath,
                        size: entry.size,
                        hasYouTubeStream: levelDict.getSetting('requiredMods')?.includes('YouTubeStream'),
                        songFilename: levelDict.getSetting('songFilename'),
                        artist: levelDict.getSetting('artist'),
                        song: levelDict.getSetting('song'),
                        author: levelDict.getSetting('author'),
                        difficulty: levelDict.getSetting('difficulty'),
                        bpm: levelDict.getSetting('bpm')
                    };
                }

                levelFiles[entry.relativePath] = levelFile;
                allLevelFiles.push(levelFile);
                totalLevelSize += entry.size;
                processedLevels++;

                // Update progress: 15-40% for level processing
                if (levelEntries.length > 0) {
                    const levelProgress = 15 + Math.round((processedLevels / levelEntries.length) * 25);
                    await sendProgress('processing', levelProgress, `Processing level files (${processedLevels}/${levelEntries.length})`);
                }

                logger.debug('Processed level file:', {
                    name: levelFilename,
                    size: entry.size,
                    path: tempPath,
                    hasYouTubeStream: levelFile.hasYouTubeStream,
                    skippedParse: tooLargeToParse
                });
            } catch (error) {
                logger.debug('Skipped level file during archive scan (parse/validation):', {
                    entry: entry.relativePath,
                    error: error instanceof Error ? error.message : String(error)
                });
                await fs.promises.unlink(tempPath).catch(() => undefined); // Clean up temp file
            }
        }

        // Second pass: collect all song files
        await sendProgress('processing', 40, 'Processing song files');
        let totalSongSize = 0;
        const audioExtensions = [
            '.mp3', '.wav', '.ogg', '.oga', '.opus', '.flac', '.m4a', '.aac',
            '.aiff', '.aif', '.caf', '.wma', '.webm', '.mka', '.ac3', '.eac3',
            '.mp2', '.amr', '.ape', '.wv', '.tta'
        ];
        const songEntries = archiveEntries.filter(entry =>
            !entry.isDirectory && audioExtensions.includes(path.extname(entry.relativePath).toLowerCase())
        );
        let processedSongs = 0;
        for (const entry of songEntries) {
            const normalizedSongPath = normalizeRelativePath(entry.relativePath);
            const songTempPath = path.join(extractRoot, normalizedSongPath);

            if (!fs.existsSync(songTempPath)) {
                logger.debug('Song file missing after bulk extraction, skipping', {
                    relativePath: normalizedSongPath,
                    songTempPath
                });
                continue;
            }

            const songFilename = path.basename(entry.relativePath);
            if (songFiles[songFilename]) {
                logger.debug('Duplicate song basename in archive (metadata keeps last wins)', {
                    basename: songFilename,
                    earlierPath: songFiles[songFilename].path
                });
            }

            songFiles[songFilename] = {
                name: songFilename,
                path: songTempPath, // Keep temp path for now, will be uploaded later
                size: entry.size,
                type: path.extname(entry.relativePath).toLowerCase().slice(1)
            };
            totalSongSize += entry.size;
            processedSongs++;

            // Update progress: 40-50% for song processing
            if (songEntries.length > 0) {
                const songProgress = 40 + Math.round((processedSongs / songEntries.length) * 10);
                await sendProgress('processing', songProgress, `Processing song files (${processedSongs}/${songEntries.length})`);
            }
        }

        // Upload files to hybrid storage (Spaces or local)
        logger.debug('Uploading processed files to hybrid storage', {
            fileId: archiveFileId,
            levelCount: allLevelFiles.length,
            songCount: Object.keys(songFiles).length
        });

        // Upload level files
        await sendProgress('uploading', 50, 'Uploading level files');
        const levelUploadResult = await spacesStorage.uploadLevelFiles(
            allLevelFiles.map(file => ({
                sourcePath: file.path,
                filename: file.relativePath,
                size: file.size
            })),
            archiveFileId
        );
        await sendProgress('uploading', 65, 'Level files uploaded');

        const sourceCopyResults: Array<{ path: string; storageType: string }> = [];
        for (const file of allLevelFiles) {
            const sourceCopyRelativePath = file.sourceCopyRelativePath || toCopyRelativePath(file.relativePath);
            const sourceCopyKey = `levels/${archiveFileId}/${sourceCopyRelativePath}`;
            await spacesStorage.uploadFile(file.path, sourceCopyKey, 'application/octet-stream', {
                fileId: archiveFileId,
                sourceType: 'original-level-copy',
                originalRelativePath: encodeURIComponent(file.relativePath),
                uploadedAt: new Date().toISOString()
            });
            sourceCopyResults.push({
                path: sourceCopyKey,
                storageType: 'spaces'
            });
        }

        // Update file paths in metadata
        allLevelFiles.forEach((file, index) => {
            const uploadedFile = levelUploadResult.files[index];
            const uploadedSourceCopy = sourceCopyResults[index];
            file.path = uploadedFile.path;
            file.sourceCopyPath = uploadedSourceCopy.path;
            file.sourceCopyStorageType = uploadedSourceCopy.storageType;
        });

        // Upload song files using hybrid storage manager
        await sendProgress('uploading', 65, 'Uploading song files');
        const songUploadResult = await spacesStorage.uploadSongFiles(
            Object.values(songFiles).map(songFile => ({
                sourcePath: songFile.path,
                filename: songFile.name,
                size: songFile.size,
                type: songFile.type
            })),
            archiveFileId
        );
        await sendProgress('uploading', 80, 'Song files uploaded');

        // Update file paths in metadata
        const updatedSongFiles: { [key: string]: any } = {};
        songUploadResult.files.forEach((uploadedFile, index) => {
            const originalSongFile = Object.values(songFiles)[index];
            updatedSongFiles[uploadedFile.filename] = {
                ...originalSongFile,
                path: uploadedFile.path,
                url: uploadedFile.url,
                key: uploadedFile.key
            };
        });

        // Upload original archive file (preserve byte-for-byte with original extension/MIME)
        await sendProgress('uploading', 80, 'Uploading original archive file');
        const archiveUploadResult = await spacesStorage.uploadArchiveFile(
            originalArchiveDiskPath,
            archiveFileId,
            finalArchiveName,
            archiveContentType
        );
        await sendProgress('uploading', 90, 'Original archive file uploaded');

        // No early disk cleanup needed: the workspace `finally` removes `permanentDir`
        // when the function returns. Anything still living under it (the original-archive
        // copy and `.extracted/`) goes with it.

        // Determine target level
        let targetLevel: string | null = null;
        let targetLevelRelativePath: string | null = null;
        let targetLevelOversized = false;
        const pathConfirmed = false;

        if (allLevelFiles.length > 0) {
            // Filter out backup.adofai files first, prefer any other level file
            const nonBackupFiles = allLevelFiles.filter(file =>
                file.name.toLowerCase() !== 'backup.adofai'
            );

            // Select target level: prefer non-backup files, fall back to backup if it's the only option
            const candidateFiles = nonBackupFiles.length > 0 ? nonBackupFiles : allLevelFiles;

            // Select the largest level file from candidates
            const largestLevel = candidateFiles.reduce((largest, current) => {
                return (current.size > largest.size) ? current : largest;
            });

            targetLevel = largestLevel.path; // Use storage path (Spaces key or local path)
            targetLevelRelativePath = largestLevel.relativePath;
            targetLevelOversized = !!largestLevel.oversizedUnparsed;
            selectedPreloadedTargetLevelData =
                nonBackupFiles.length > 0 ? preloadedNonBackupLevelData : preloadedBackupLevelData;

            logger.debug('Selected largest level file as target:', {
                selectedLevel: largestLevel.name,
                size: largestLevel.size,
                path: largestLevel.path,
                totalLevels: allLevelFiles.length,
                nonBackupCount: nonBackupFiles.length,
                isBackup: largestLevel.name.toLowerCase() === 'backup.adofai',
                targetLevelOversized
            });
        }

        // Start transaction for database operations
        await sendProgress('processing', 90, 'Creating database entry');
        transaction = await cdnSequelize.transaction();

        // The same archive object is referenced under both `originalArchive` (new shape with
        // explicit format/contentType) and `originalZip` (legacy alias for backward compatibility
        // with readers in routes/levels.ts, routes/zips.ts, services/levelCacheService.ts).
        const originalArchiveMeta = {
            name: finalArchiveName,
            path: archiveUploadResult.filePath,
            size: originalArchiveSize,
            originalFilename: finalArchiveName,
            format: detectedFormat,
            contentType: archiveContentType,
            extension: getArchiveExtension(detectedFormat)
        };

        // Create database entry with comprehensive storage information
        const cdnFile = await CdnFile.create({
            id: archiveFileId,
            type: 'LEVELZIP',
            filePath: archiveUploadResult.filePath, // Use the actual storage path
            metadata: {
                levelFiles,
                allLevelFiles,
                songFiles: updatedSongFiles,
                targetLevel,
                targetLevelRelativePath,
                targetLevelOversized,
                pathConfirmed,
                // Canonical, format-aware archive descriptor.
                originalArchive: originalArchiveMeta,
                // Legacy alias kept for code paths still reading `originalZip`. Same object
                // reference so both views stay in sync.
                originalZip: originalArchiveMeta,
                // Add timestamp for debugging
                uploadedAt: new Date().toISOString(),
            }
        }, { transaction });

        // Commit the transaction
        await transaction.commit();
        await sendProgress('processing', 95, 'Database entry created');

        // Populate cache immediately using the extracted/parsed target LevelDict, when available.
        // This avoids the redundant download/parse roundtrip in `ensureCachePopulated`.
        if (targetLevel && !targetLevelOversized && selectedPreloadedTargetLevelData) {
            try {
                await sendProgress('caching', 96, 'Populating cache from extracted level');
                await levelCacheService.populateCache(
                    cdnFile,
                    targetLevel,
                    undefined,
                    selectedPreloadedTargetLevelData
                );

                // Also normalize the stored .adofai JSON immediately so future loads can safely parse it
                // without extracting/re-writing from the original source.
                // (We already have the parsed LevelDict; no Spaces download is needed.)
                const normalizedJson = JSON.stringify(selectedPreloadedTargetLevelData.toJSON(), null, 4);
                await spacesStorage.uploadBuffer(Buffer.from(normalizedJson, 'utf8'), targetLevel, 'application/json');

                await cdnFile.update({
                    metadata: {
                        ...(cdnFile.metadata as any),
                        targetSafeToParse: true,
                        targetSafeToParseVersion: SAFE_TO_PARSE_VERSION
                    }
                });
            } catch (cacheError) {
                logger.warn('Failed to populate cache from extracted level (non-critical):', {
                    fileId: archiveFileId,
                    error: cacheError instanceof Error ? cacheError.message : String(cacheError)
                });
            }
        }

        logger.debug('Successfully processed archive file:', {
            fileId: archiveFileId,
            format: detectedFormat,
            permanentDir,
            levelCount: allLevelFiles.length,
            songCount: Object.keys(updatedSongFiles).length,
            totalLevelSize,
            totalSongSize,
            originalArchiveSize,
            totalSize: totalLevelSize + totalSongSize + originalArchiveSize,
            targetLevel,
            pathConfirmed,
            hasOriginalArchive: true
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

        // `permanentDir` (the workspace dir) is removed by `withWorkspace`'s `finally` —
        // no manual filesystem cleanup needed here regardless of failure mode.

        const errObj = error instanceof Error ? error : null;
        const anyErr = errObj as (Error & {
            exitCode?: number;
            sevenZSummary?: string;
            sevenZBinary?: string;
            clientFacing?: boolean;
            archiveErrorKind?: string;
            userMessage?: string;
        }) | null;

        // User-supplied archive is bad (corrupt / encrypted / wrong format) — not a server bug.
        // Log at `info` with a concise payload and forward the short userMessage to progress.
        if (anyErr?.clientFacing) {
            logger.info('Archive rejected (user error):', {
                archiveFileId,
                archiveFilePath,
                archiveErrorKind: anyErr.archiveErrorKind,
                userMessage: anyErr.userMessage,
                ...(typeof anyErr.exitCode === 'number' ? { sevenZExitCode: anyErr.exitCode } : {})
            });
            await sendProgress('failed', 0, anyErr.userMessage ?? 'Archive could not be processed');
            throw error;
        }

        logger.error('Error processing archive file:', {
            error: errObj?.message ?? String(error),
            stack: errObj?.stack,
            ...(typeof anyErr?.exitCode === 'number' ? { sevenZExitCode: anyErr.exitCode } : {}),
            ...(typeof anyErr?.sevenZBinary === 'string' ? { sevenZBinary: anyErr.sevenZBinary } : {}),
            ...(typeof anyErr?.sevenZSummary === 'string' ? { sevenZSummary: anyErr.sevenZSummary } : {}),
            archiveFilePath,
            archiveFileId,
            timestamp: new Date().toISOString()
        });

        // Send failure progress update (cap length — full report is already in logs above)
        {
            const msg = errObj?.message ?? String(error);
            const capped = msg.length > 1600 ? `${msg.slice(0, 1600)}… [truncated]` : msg;
            await sendProgress('failed', 0, capped);
        }
        throw error;
    }
}

/**
 * Backwards-compatible alias. Older callers used `processZipFile`; new code should call
 * `processArchiveFile`. Both accept any supported archive format (the function detects
 * the format internally).
 */
export const processZipFile = processArchiveFile;


interface RepackMetadata {
    levelFile: {
        name: string;
        path: string;
        size: number;
    };
    songFile?: {
        name: string;
        path: string;
        size: number;
        type: string;
    };
}

export async function repackZipFile(metadata: RepackMetadata, outputDir?: string): Promise<string> {
    let tempZipPath: string | null = null;

    logger.debug('Starting zip file repacking:', { metadata, outputDir });

    try {
        if (outputDir) {
            await fs.promises.mkdir(outputDir, { recursive: true });
            tempZipPath = path.join(
                outputDir,
                'repacked_' + Date.now() + '_' + Math.random().toString(36).substring(7) + '.zip'
            );
        } else {
            const storageRoot = cdnLocalTemp.getLocalRoot();
            tempZipPath = path.join(
                storageRoot,
                'temp',
                'repacked_' + Date.now() + '_' + Math.random().toString(36).substring(7) + '.zip'
            );
        }
        logger.debug('Created temporary zip path:', { tempZipPath });

        const filesToZip: { path: string; nameInArchive: string }[] = [
            { path: metadata.levelFile.path, nameInArchive: metadata.levelFile.name }
        ];

        if (metadata.songFile) {
            filesToZip.push({
                path: metadata.songFile.path,
                nameInArchive: metadata.songFile.name
            });
        }

        logger.debug('Writing zip via archiveService:', {
            tempZipPath,
            files: filesToZip.map(f => f.nameInArchive)
        });
        await archiveCreateZipFromFiles(filesToZip, tempZipPath);

        logger.debug('Zip file repacked successfully');
        return tempZipPath;
    } catch (error) {
        logger.error('Error repacking zip file:', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            metadata,
            tempZipPath,
            outputDir
        });

        if (tempZipPath) {
            logger.debug('Cleaning up temporary zip file due to error:', { tempZipPath });
            // Only cleanup if it's in the temp folder, not in the repack folder
            if (!outputDir) {
                cdnLocalTemp.cleanupFiles(tempZipPath);
            }
        }
        throw new Error('Failed to repack zip file');
    }
}
