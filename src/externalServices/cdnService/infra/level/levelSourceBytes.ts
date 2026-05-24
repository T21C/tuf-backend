import fs from 'fs';
import path from 'path';
import { logger } from '@/server/services/core/LoggerService.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import { spacesStorage } from '../storage/spacesStorage.js';
import {
    listEntries as archiveListEntries,
    extractEntry as archiveExtractEntry,
    getOriginalArchiveMeta,
    type ArchiveEntry
} from '../archive/archiveService.js';
import { normalizeRelativePath, toCopyRelativePath, toSourceRelativePath } from '../../domain/archive/ingestPaths.js';

export type LevelMetadataEntry = {
    name?: string;
    relativePath?: string;
    path?: string;
    sourcePath?: string;
    sourceRelativePath?: string;
    sourceStorageType?: string;
    sourceCopyPath?: string;
    sourceCopyRelativePath?: string;
    sourceCopyStorageType?: string;
    size?: number;
};

export function buildLevelSourceStorageKey(fileId: string, levelRelativePath: string): string {
    return `levels/${fileId}/${toSourceRelativePath(levelRelativePath)}`;
}

export function buildLegacyLevelCopyStorageKey(fileId: string, levelRelativePath: string): string {
    return `levels/${fileId}/${toCopyRelativePath(levelRelativePath)}`;
}

/** Locate the archive member for a level metadata entry. */
export function findArchiveEntryForLevel(
    entries: ArchiveEntry[],
    levelEntry: LevelMetadataEntry
): ArchiveEntry | null {
    const targetRelativePath = levelEntry.relativePath
        ? normalizeRelativePath(String(levelEntry.relativePath))
        : null;
    const targetLevelName = levelEntry.name || (targetRelativePath ? path.posix.basename(targetRelativePath) : null);

    if (targetRelativePath) {
        const exact = entries.find((entry) => normalizeRelativePath(entry.relativePath) === targetRelativePath);
        if (exact) {
            return exact;
        }
    }

    if (!targetLevelName) {
        return null;
    }

    for (const entry of entries) {
        if (entry.isDirectory) continue;
        if (entry.name === targetLevelName || entry.relativePath.endsWith(targetLevelName)) {
            return entry;
        }
    }

    return null;
}

export async function extractArchiveEntryToWorkspace(
    archivePath: string,
    entry: ArchiveEntry,
    join: (...parts: string[]) => string,
    outputBasename = `extracted_${Date.now()}.adofai`
): Promise<{ localPath: string; size: number }> {
    const extractedPath = join(outputBasename);
    await archiveExtractEntry(archivePath, entry, extractedPath);
    const size = (await fs.promises.stat(extractedPath)).size;
    return { localPath: extractedPath, size };
}

/**
 * Extract byte-for-byte .adofai bytes from the stored original archive (never from canonical/source objects).
 */
export async function extractLevelBytesFromArchive(params: {
    metadata: unknown;
    levelEntry: LevelMetadataEntry;
    join: (...parts: string[]) => string;
    archiveLocalPath: string;
    archiveEntries?: ArchiveEntry[];
}): Promise<{ localPath: string; size: number } | null> {
    const { metadata, levelEntry, join, archiveLocalPath } = params;
    const archiveMeta = getOriginalArchiveMeta(metadata);
    if (!archiveMeta?.path) {
        logger.warn('No original archive path in metadata');
        return null;
    }

    try {
        const entries = params.archiveEntries ?? (await archiveListEntries(archiveLocalPath));
        const foundEntry = findArchiveEntryForLevel(entries, levelEntry);
        if (!foundEntry) {
            logger.warn('Level file not found in archive', {
                relativePath: levelEntry.relativePath,
                name: levelEntry.name
            });
            return null;
        }

        const relativeSlug = normalizeRelativePath(String(levelEntry.relativePath || levelEntry.name || 'level.adofai'))
            .replace(/[^\w.-]+/g, '_');
        return await extractArchiveEntryToWorkspace(
            archiveLocalPath,
            foundEntry,
            join,
            `archive_extract_${relativeSlug}_${Date.now()}.adofai`
        );
    } catch (error) {
        logger.error('Failed to extract level bytes from archive', {
            relativePath: levelEntry.relativePath,
            error: error instanceof Error ? error.message : String(error)
        });
        return null;
    }
}

export async function uploadLevelSourceObject(
    localPath: string,
    storageKey: string,
    params: { fileId: string; originalRelativePath: string }
): Promise<{ path: string; size: number }> {
    const size = (await fs.promises.stat(localPath)).size;
    await spacesStorage.uploadFile(localPath, storageKey, 'application/octet-stream', {
        fileId: params.fileId,
        sourceType: 'original-level-source',
        originalRelativePath: encodeURIComponent(params.originalRelativePath),
        uploadedAt: new Date().toISOString()
    });
    return { path: storageKey, size };
}

export function patchLevelEntrySourceFields(
    entry: LevelMetadataEntry,
    sourcePath: string,
    sourceRelativePath: string
): void {
    entry.sourcePath = sourcePath;
    entry.sourceRelativePath = sourceRelativePath;
    entry.sourceStorageType = 'spaces';
    delete entry.sourceCopyPath;
    delete entry.sourceCopyRelativePath;
    delete entry.sourceCopyStorageType;
}

export function getTargetLevelMetadataEntry(metadata: any, targetLevelPath: string): any | null {
    const allLevelFiles = metadata?.allLevelFiles || [];
    const normalizedTargetPath = String(targetLevelPath).replace(/\\/g, '/').replace(/^\/+/, '');
    for (const levelFile of allLevelFiles) {
        const filePath = String(levelFile?.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
        const relativePath = String(levelFile?.relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (filePath === normalizedTargetPath || relativePath === normalizedTargetPath) {
            return levelFile;
        }
    }
    return null;
}

/** Resolve persisted storage key for the immutable pre-parse level bytes. */
export function resolveLevelSourceStoragePath(levelEntry: any): string | null {
    if (!levelEntry) {
        return null;
    }
    return levelEntry.sourcePath ?? levelEntry.sourceCopyPath ?? null;
}

export async function downloadLevelToWorkspace(levelPath: string, join: (...parts: string[]) => string): Promise<{ localPath: string }> {
    const levelExists = await spacesStorage.fileExists(levelPath);
    if (!levelExists) {
        throw new Error(`Target level file not found in storage: ${levelPath}`);
    }

    const ext = path.extname(levelPath) || '.adofai';
    const tempPath = join(`level_${Date.now()}${ext}`);
    await spacesStorage.downloadFileToPathStreaming(levelPath, tempPath);

    return { localPath: tempPath };
}

/**
 * Download original .adofai bytes from Spaces (stored source object or zip) into the current workspace.
 */
export async function extractLevelSourceFromMetadata(params: {
    file: CdnFile;
    targetLevelPath: string;
    metadata: any;
    join: (...parts: string[]) => string;
}): Promise<{ localPath: string } | null> {
    const { file, targetLevelPath, metadata, join } = params;

    try {
        const targetLevelEntry = getTargetLevelMetadataEntry(metadata, targetLevelPath);
        const sourceStoragePath = resolveLevelSourceStoragePath(targetLevelEntry);

        if (sourceStoragePath) {
            const sourceCheck = await spacesStorage.fileExists(sourceStoragePath);
            if (!sourceCheck) {
                throw new Error(`Level source file not found in storage: ${sourceStoragePath}`);
            }

            const ext = path.extname(String(targetLevelEntry?.relativePath || targetLevelPath)) || '.adofai';
            const targetSourcePath = join(`level_source_${Date.now()}${ext}`);
            await spacesStorage.downloadFileToPathStreaming(sourceStoragePath, targetSourcePath);
            return { localPath: targetSourcePath };
        }

        const originalZip = getOriginalArchiveMeta(metadata) ?? metadata?.originalZip;
        if (!originalZip?.path) {
            logger.warn('No original archive path in metadata, cannot extract level source', { fileId: file.id });
            return null;
        }

        const tempZipPath = join(`original_${Date.now()}.zip`);

        logger.debug('Downloading archive for level source extraction', {
            fileId: file.id,
            archivePath: originalZip.path,
            tempZipPath
        });

        await spacesStorage.downloadFileToPathStreaming(originalZip.path, tempZipPath);

        const levelEntry = targetLevelEntry || getTargetLevelMetadataEntry(metadata, targetLevelPath);
        if (!levelEntry) {
            return null;
        }

        try {
            const extracted = await extractLevelBytesFromArchive({
                metadata,
                levelEntry,
                join,
                archiveLocalPath: tempZipPath
            });
            if (!extracted) {
                return null;
            }

            logger.debug('Level source extracted successfully from archive', {
                fileId: file.id,
                extractedPath: extracted.localPath,
                size: extracted.size
            });

            return { localPath: extracted.localPath };
        } finally {
            await fs.promises.unlink(tempZipPath).catch(() => Promise.resolve());
        }
    } catch (error) {
        logger.error('Failed to extract level source', {
            fileId: file.id,
            error: error instanceof Error ? error.message : String(error)
        });
        return null;
    }
}

/** @deprecated Use {@link extractLevelSourceFromMetadata}. */
export const extractSourceCopyFromMetadata = extractLevelSourceFromMetadata;
