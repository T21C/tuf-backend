/**
 * Dry-run analysis of a level pack archive (zip/rar/7z/tar…) — same discovery path as
 * {@link ../../services/zipProcessor.ts} ingest, without uploads or DB writes.
 *
 * Used by {@link ../../scripts/analyzeLevelPack.ts} for manual edge-case inspection.
 */

import fs from 'fs';
import path from 'path';
import LevelDict from 'adofai-lib';
import {
    detectArchiveFormat,
    getArchiveExtension,
    getArchiveMimeType,
    extractLevelPackPayload as archiveExtractLevelPackPayload,
    type ArchiveEntry
} from '../../infra/archive/archiveService.js';
import {
    rewriteZipFilenamesToUtf8,
    zipArchiveFilenamesAlreadyUtf8Clean
} from '../../infra/archive/zipUtf8FilenameRewrite.js';
import { listArchiveEntriesForIngest } from '../archive/ingestArchiveEntries.js';
import { normalizeRelativePath, toSourceRelativePath } from '../archive/ingestPaths.js';
import { LEVEL_SUPPORTED_AUDIO_EXTENSION_SET } from '../../constants/levelPackAudio.js';
import {
    MAX_LEVEL_FILE_SIZE_FOR_PARSE,
    MAX_LEVEL_TILECOUNT_FOR_FULL_PARSE
} from './levelParseLimits.js';
import {
    scanOversizedLevelFile,
    type OversizedLevelBasics
} from './oversizedHandling/oversizedLevelScan.js';
import { computeLevelCacheMetadataSignature } from './levelCacheSignature.js';

export type LevelParsePath =
    | 'leveldict'
    | 'stream-scan'
    | 'skipped-size'
    | 'skipped-tiles'
    | 'missing-after-extract'
    | 'parse-error';

export type AnalyzedLevelFile = {
    name: string;
    relativePath: string;
    size: number;
    extracted: boolean;
    parsePath: LevelParsePath;
    parseError?: string;
    hasYouTubeStream?: boolean;
    songFilename?: unknown;
    artist?: unknown;
    song?: unknown;
    author?: unknown;
    difficulty?: unknown;
    bpm?: unknown;
    tilecount?: number;
    oversizedUnparsed?: boolean;
    oversizedBasics?: OversizedLevelBasics;
};

export type AnalyzedSongFile = {
    name: string;
    relativePath: string;
    size: number;
    type: string;
    extracted: boolean;
};

export type LevelPackTargetSelection = {
    name: string;
    relativePath: string;
    size: number;
    oversizedUnparsed: boolean;
    selectionReason: string;
};

/** Subset of persisted LEVELZIP metadata shape (paths are illustrative, not uploaded). */
export type ProposedLevelzipMetadata = {
    levelFiles: Record<string, Record<string, unknown>>;
    allLevelFiles: Array<Record<string, unknown>>;
    songFiles: Record<string, Record<string, unknown>>;
    targetLevel: string | null;
    targetLevelRelativePath: string | null;
    targetLevelOversized: boolean;
    pathConfirmed: boolean;
    originalArchive: {
        name: string;
        path: string;
        size: number;
        originalFilename: string;
        format: string;
        contentType: string;
        extension: string;
    };
    originalZip: Record<string, unknown>;
    analyzedAt: string;
    cacheMetadataSignature: string;
};

export type LevelPackAnalysisResult = {
    sourceArchivePath: string;
    ingestArchivePath: string;
    detectedFormat: string;
    originalFilename: string;
    utf8FilenameRewrite: {
        applied: boolean;
        skippedBecauseClean?: boolean;
        reason?: string;
        detail?: string;
        entriesWritten?: number;
        detectionReason?: string;
        codePage?: number;
    };
    ingestLimits: {
        maxLevelFileSizeForParse: number;
        maxTilecountForFullParse: number;
    };
    archiveEntryCount: number;
    archiveEntriesSample: Array<{ relativePath: string; size: number; isDirectory: boolean }>;
    archiveEntriesTruncated: boolean;
    levelFileCount: number;
    songFileCount: number;
    levelFiles: AnalyzedLevelFile[];
    songFiles: AnalyzedSongFile[];
    targetLevel: LevelPackTargetSelection | null;
    proposedMetadata: ProposedLevelzipMetadata;
};

export type AnalyzeLevelPackOptions = {
    signal?: AbortSignal;
    /** List entries only; skip 7z extract and LevelDict / stream scan. */
    skipExtract?: boolean;
    /** Force target selection to this relative path (must exist in archive). */
    forceTargetRelativePath?: string;
    /** Used for illustrative storage paths in proposed metadata (`levels/{fileId}/…`). */
    fileId?: string;
    originalFilename?: string;
};

function storagePathForLevel(relativePath: string, fileId?: string): string {
    const normalised = normalizeRelativePath(relativePath);
    return fileId ? `levels/${fileId}/${normalised}` : normalised;
}

function toMetadataLevelEntry(
    analyzed: AnalyzedLevelFile,
    fileId?: string
): Record<string, unknown> {
    const entry: Record<string, unknown> = {
        name: analyzed.name,
        relativePath: analyzed.relativePath,
        path: storagePathForLevel(analyzed.relativePath, fileId),
        sourceRelativePath: toSourceRelativePath(analyzed.relativePath),
        size: analyzed.size,
        hasYouTubeStream: analyzed.hasYouTubeStream ?? false,
        songFilename: analyzed.songFilename,
        artist: analyzed.artist,
        song: analyzed.song,
        author: analyzed.author,
        difficulty: analyzed.difficulty,
        bpm: analyzed.bpm
    };
    if (analyzed.oversizedUnparsed) {
        entry.oversizedUnparsed = true;
    }
    if (analyzed.parsePath !== 'missing-after-extract') {
        entry.sourcePath = `levels/${fileId ?? '__fileId__'}/${toSourceRelativePath(analyzed.relativePath)}`;
        entry.sourceStorageType = 'spaces';
    }
    return entry;
}

function selectTargetLevel(
    levelFiles: AnalyzedLevelFile[],
    forceTargetRelativePath?: string
): LevelPackTargetSelection | null {
    const usable = levelFiles.filter((f) => f.extracted && f.parsePath !== 'missing-after-extract');
    if (usable.length === 0) return null;

    if (forceTargetRelativePath) {
        const forced = usable.find(
            (f) => normalizeRelativePath(f.relativePath) === normalizeRelativePath(forceTargetRelativePath)
        );
        if (forced) {
            return {
                name: forced.name,
                relativePath: forced.relativePath,
                size: forced.size,
                oversizedUnparsed: !!forced.oversizedUnparsed,
                selectionReason: 'forced via --target'
            };
        }
    }

    const nonBackup = usable.filter((f) => f.name.toLowerCase() !== 'backup.adofai');
    const candidates = nonBackup.length > 0 ? nonBackup : usable;
    const largest = candidates.reduce((a, b) => (b.size > a.size ? b : a));
    const isBackup = largest.name.toLowerCase() === 'backup.adofai';

    return {
        name: largest.name,
        relativePath: largest.relativePath,
        size: largest.size,
        oversizedUnparsed: !!largest.oversizedUnparsed,
        selectionReason:
            nonBackup.length > 0
                ? `largest non-backup .adofai (${largest.size} bytes)`
                : isBackup
                  ? 'largest file (only backup.adofai available)'
                  : `largest .adofai (${largest.size} bytes)`
    };
}

/**
 * Analyze a level pack on disk inside `workspaceDir` (caller owns cleanup).
 */
export async function analyzeLevelPackArchive(
    archiveFilePath: string,
    workspaceDir: string,
    options: AnalyzeLevelPackOptions = {}
): Promise<LevelPackAnalysisResult> {
    const signal = options.signal;
    const originalFilename =
        options.originalFilename ?? path.basename(archiveFilePath);
    const detectedFormat = detectArchiveFormat(originalFilename) || detectArchiveFormat(archiveFilePath) || 'zip';
    const archiveContentType = getArchiveMimeType(detectedFormat);
    const archiveSize = (await fs.promises.stat(archiveFilePath)).size;

    let ingestArchivePath = archiveFilePath;
    const utf8FilenameRewrite: LevelPackAnalysisResult['utf8FilenameRewrite'] = {
        applied: false
    };

    if (detectedFormat === 'zip') {
        const alreadyUtf8Clean = await zipArchiveFilenamesAlreadyUtf8Clean(archiveFilePath);
        if (alreadyUtf8Clean) {
            utf8FilenameRewrite.skippedBecauseClean = true;
        } else {
            const normalizedZipPath = path.join(workspaceDir, '.analyze-utf8-filenames.zip');
            const rw = await rewriteZipFilenamesToUtf8(archiveFilePath, normalizedZipPath, signal);
            if (rw.ok) {
                ingestArchivePath = normalizedZipPath;
                utf8FilenameRewrite.applied = true;
                utf8FilenameRewrite.entriesWritten = rw.entriesWritten;
                utf8FilenameRewrite.detectionReason = rw.detectionReason;
                utf8FilenameRewrite.codePage = rw.codePage ?? undefined;
            } else {
                utf8FilenameRewrite.reason = rw.reason;
                utf8FilenameRewrite.detail = rw.detail;
            }
        }
    }

    const archiveEntries = await listArchiveEntriesForIngest(ingestArchivePath, signal);
    const levelEntries = archiveEntries.filter(
        (entry) => !entry.isDirectory && entry.relativePath.toLowerCase().endsWith('.adofai')
    );
    const songEntries = archiveEntries.filter(
        (entry) =>
            !entry.isDirectory &&
            LEVEL_SUPPORTED_AUDIO_EXTENSION_SET.has(path.extname(entry.relativePath).toLowerCase())
    );

    const levelFiles: AnalyzedLevelFile[] = [];
    const songFiles: AnalyzedSongFile[] = [];

    if (!options.skipExtract) {
        const extractRoot = path.join(workspaceDir, '.extracted');
        const requiredLevelPaths = levelEntries.map((entry) => normalizeRelativePath(entry.relativePath));
        await archiveExtractLevelPackPayload(ingestArchivePath, extractRoot, signal, {
            requiredRelativePaths: requiredLevelPaths
        });

        for (const entry of levelEntries) {
            const normalizedRelativePath = normalizeRelativePath(entry.relativePath);
            const tempPath = path.join(extractRoot, normalizedRelativePath);
            const levelFilename = path.basename(entry.relativePath);

            if (!fs.existsSync(tempPath)) {
                levelFiles.push({
                    name: levelFilename,
                    relativePath: normalizedRelativePath,
                    size: entry.size,
                    extracted: false,
                    parsePath: 'missing-after-extract'
                });
                continue;
            }

            const tooLargeToParse = entry.size > MAX_LEVEL_FILE_SIZE_FOR_PARSE;
            let scanned: OversizedLevelBasics | null = null;
            try {
                scanned = await scanOversizedLevelFile(tempPath);
            } catch {
                scanned = null;
            }

            const tilecountOverLimit =
                scanned !== null && scanned.tilecount > MAX_LEVEL_TILECOUNT_FOR_FULL_PARSE;
            const skipLevelDict = tooLargeToParse || tilecountOverLimit;

            if (skipLevelDict) {
                levelFiles.push({
                    name: levelFilename,
                    relativePath: normalizedRelativePath,
                    size: entry.size,
                    extracted: true,
                    parsePath: tooLargeToParse ? 'skipped-size' : 'skipped-tiles',
                    tilecount: scanned?.tilecount,
                    songFilename: scanned?.settings?.songFilename,
                    artist: scanned?.settings?.artist,
                    song: scanned?.settings?.song,
                    author: scanned?.settings?.author,
                    bpm: scanned?.settings?.bpm,
                    oversizedUnparsed: true,
                    oversizedBasics: scanned ?? undefined
                });
                continue;
            }

            try {
                // Read-only pack analysis; canonical persistence uses levelCacheService on ingest.
                const levelDict = new LevelDict(tempPath);
                levelFiles.push({
                    name: levelFilename,
                    relativePath: normalizedRelativePath,
                    size: entry.size,
                    extracted: true,
                    parsePath: 'leveldict',
                    tilecount: scanned?.tilecount,
                    hasYouTubeStream: levelDict.getSetting('requiredMods')?.includes('YouTubeStream'),
                    songFilename: levelDict.getSetting('songFilename'),
                    artist: levelDict.getSetting('artist'),
                    song: levelDict.getSetting('song'),
                    author: levelDict.getSetting('author'),
                    difficulty: levelDict.getSetting('difficulty'),
                    bpm: levelDict.getSetting('bpm')
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                levelFiles.push({
                    name: levelFilename,
                    relativePath: normalizedRelativePath,
                    size: entry.size,
                    extracted: true,
                    parsePath: 'parse-error',
                    parseError: message,
                    tilecount: scanned?.tilecount,
                    oversizedBasics: scanned ?? undefined
                });
            }
        }

        for (const entry of songEntries) {
            const normalizedSongPath = normalizeRelativePath(entry.relativePath);
            const songTempPath = path.join(extractRoot, normalizedSongPath);
            songFiles.push({
                name: path.basename(entry.relativePath),
                relativePath: normalizedSongPath,
                size: entry.size,
                type: path.extname(entry.relativePath).toLowerCase().slice(1),
                extracted: fs.existsSync(songTempPath)
            });
        }
    } else {
        for (const entry of levelEntries) {
            levelFiles.push({
                name: path.basename(entry.relativePath),
                relativePath: normalizeRelativePath(entry.relativePath),
                size: entry.size,
                extracted: false,
                parsePath: 'missing-after-extract'
            });
        }
        for (const entry of songEntries) {
            songFiles.push({
                name: path.basename(entry.relativePath),
                relativePath: normalizeRelativePath(entry.relativePath),
                size: entry.size,
                type: path.extname(entry.relativePath).toLowerCase().slice(1),
                extracted: false
            });
        }
    }

    const target = selectTargetLevel(levelFiles, options.forceTargetRelativePath);
    const fileId = options.fileId;

    const levelFilesMap: Record<string, Record<string, unknown>> = {};
    const allLevelFiles: Array<Record<string, unknown>> = [];
    for (const lf of levelFiles) {
        const meta = toMetadataLevelEntry(lf, fileId);
        levelFilesMap[lf.relativePath] = meta;
        allLevelFiles.push(meta);
    }

    const songFilesMap: Record<string, Record<string, unknown>> = {};
    for (const sf of songFiles) {
        songFilesMap[sf.relativePath] = {
            name: sf.name,
            path: storagePathForLevel(sf.relativePath, fileId),
            size: sf.size,
            type: sf.type
        };
    }

    const originalArchiveMeta = {
        name: originalFilename,
        path: fileId ? `zips/${fileId}/${originalFilename}` : originalFilename,
        size: archiveSize,
        originalFilename,
        format: detectedFormat,
        contentType: archiveContentType,
        extension: getArchiveExtension(detectedFormat)
    };

    const targetLevelPath = target ? storagePathForLevel(target.relativePath, fileId) : null;

    const proposedMetadata: ProposedLevelzipMetadata = {
        levelFiles: levelFilesMap,
        allLevelFiles,
        songFiles: songFilesMap,
        targetLevel: targetLevelPath,
        targetLevelRelativePath: target?.relativePath ?? null,
        targetLevelOversized: target?.oversizedUnparsed ?? false,
        pathConfirmed: false,
        originalArchive: originalArchiveMeta,
        originalZip: originalArchiveMeta,
        analyzedAt: new Date().toISOString(),
        cacheMetadataSignature: computeLevelCacheMetadataSignature({
            targetLevel: targetLevelPath,
            targetLevelOversized: target?.oversizedUnparsed ?? false,
            targetSafeToParse: false
        })
    };

    const entrySampleCap = 10;
    const archiveEntriesSample = archiveEntries.slice(0, entrySampleCap).map((e: ArchiveEntry) => ({
        relativePath: e.relativePath,
        size: e.size,
        isDirectory: e.isDirectory
    }));

    return {
        sourceArchivePath: archiveFilePath,
        ingestArchivePath,
        detectedFormat,
        originalFilename,
        utf8FilenameRewrite,
        ingestLimits: {
            maxLevelFileSizeForParse: MAX_LEVEL_FILE_SIZE_FOR_PARSE,
            maxTilecountForFullParse: MAX_LEVEL_TILECOUNT_FOR_FULL_PARSE
        },
        archiveEntryCount: archiveEntries.length,
        archiveEntriesSample,
        archiveEntriesTruncated: archiveEntries.length > entrySampleCap,
        levelFileCount: levelEntries.length,
        songFileCount: songEntries.length,
        levelFiles,
        songFiles,
        targetLevel: target,
        proposedMetadata
    };
}
