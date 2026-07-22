import fs from 'fs';
import path from 'path';
import { logger } from '@/server/services/core/LoggerService.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import {
    extractEntry as archiveExtractEntry,
    getOriginalArchiveMeta,
    listEntries as archiveListEntries,
    type ArchiveEntry
} from '../../infra/archive/archiveService.js';
import { spacesStorage } from '../../infra/storage/spacesStorage.js';
import { normalizeRelativePath } from '../archive/ingestPaths.js';
import { LEVEL_SUPPORTED_AUDIO_EXTENSION_SET } from '../../constants/levelPackAudio.js';
import { normalizeLevelzipMetadata } from '../metadata/normalizeLevelzipMetadata.js';

export type SongFilesBackfillItemResult = {
    relativePath: string;
    storagePath: string;
    size: number;
    deletedLegacyPaths: string[];
};

export type SongFilesBackfillResult = {
    fileId: string;
    skipped: boolean;
    items: SongFilesBackfillItemResult[];
};

export type SongFilesBackfillOptions = {
    dryRun?: boolean;
};

type SongMetadataEntry = {
    name?: string;
    relativePath?: string;
    path?: string;
    size?: number;
    type?: string;
};

function cloneMetadata(metadata: unknown): Record<string, unknown> {
    return JSON.parse(JSON.stringify(metadata ?? {})) as Record<string, unknown>;
}

function listAudioEntries(archiveEntries: ArchiveEntry[]): ArchiveEntry[] {
    return archiveEntries.filter(
        (entry) =>
            !entry.isDirectory &&
            LEVEL_SUPPORTED_AUDIO_EXTENSION_SET.has(path.extname(entry.relativePath).toLowerCase())
    );
}

function readExistingSongFiles(metadata: Record<string, unknown>): Record<string, SongMetadataEntry> {
    const raw = metadata.songFiles;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
    }
    return raw as Record<string, SongMetadataEntry>;
}

function collectLegacyPathsToDelete(params: {
    fileId: string;
    archivePath: string;
    existingSongFiles: Record<string, SongMetadataEntry>;
    newStoragePaths: Set<string>;
}): string[] {
    const { fileId, archivePath, existingSongFiles, newStoragePaths } = params;
    const prefix = `zips/${fileId}/`;
    const toDelete = new Set<string>();

    for (const entry of Object.values(existingSongFiles)) {
        const oldPath = typeof entry.path === 'string' ? entry.path : '';
        if (!oldPath || !oldPath.startsWith(prefix)) {
            continue;
        }
        if (oldPath === archivePath) {
            continue;
        }
        if (newStoragePaths.has(oldPath)) {
            continue;
        }
        toDelete.add(oldPath);
    }

    return [...toDelete];
}

/**
 * True when every archive audio entry already has nested metadata keyed by relative path
 * and the expected Spaces object exists (existence check skipped in dry-run).
 */
async function isSongFilesAlreadyMigrated(params: {
    fileId: string;
    audioRelativePaths: string[];
    existingSongFiles: Record<string, SongMetadataEntry>;
    checkObjectExists: boolean;
}): Promise<boolean> {
    const { fileId, audioRelativePaths, existingSongFiles, checkObjectExists } = params;

    if (audioRelativePaths.length === 0) {
        return Object.keys(existingSongFiles).length === 0;
    }

    if (Object.keys(existingSongFiles).length !== audioRelativePaths.length) {
        return false;
    }

    for (const relativePath of audioRelativePaths) {
        const entry = existingSongFiles[relativePath];
        const expectedPath = spacesStorage.buildSongStorageKey(fileId, relativePath);
        if (!entry || entry.path !== expectedPath) {
            return false;
        }
        const entryRel =
            typeof entry.relativePath === 'string' && entry.relativePath.length > 0
                ? normalizeRelativePath(entry.relativePath)
                : null;
        if (entryRel !== relativePath) {
            return false;
        }
        if (checkObjectExists && !(await spacesStorage.fileExists(expectedPath))) {
            return false;
        }
    }

    return true;
}

/**
 * Re-extract audio from the stored original archive, upload under nested
 * `zips/{fileId}/{relativePath}` keys, rewrite `metadata.songFiles`, and delete
 * legacy basename-only song objects (never the original archive).
 */
export async function backfillSongFilesForZipRow(
    file: CdnFile,
    join: (...parts: string[]) => string,
    options: SongFilesBackfillOptions = {}
): Promise<SongFilesBackfillResult> {
    const metadata = cloneMetadata(file.metadata);
    const archiveMeta = getOriginalArchiveMeta(metadata);
    if (!archiveMeta?.path) {
        throw new Error(`LEVELZIP ${file.id} has no originalArchive/originalZip path in metadata`);
    }

    const existingSongFiles = readExistingSongFiles(metadata);
    const dryRun = options.dryRun === true;

    const archiveLocalPath = join(`original_archive_${Date.now()}${archiveMeta.extension || '.zip'}`);
    await spacesStorage.downloadFileToPathStreaming(archiveMeta.path, archiveLocalPath);

    try {
        const archiveEntries = await archiveListEntries(archiveLocalPath);
        const audioEntries = listAudioEntries(archiveEntries);
        const audioRelativePaths: string[] = [];
        for (const entry of audioEntries) {
            try {
                audioRelativePaths.push(normalizeRelativePath(entry.relativePath));
            } catch (error) {
                logger.warn('Skipping audio entry with unsafe relative path', {
                    fileId: file.id,
                    relativePath: entry.relativePath,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }

        const alreadyMigrated = await isSongFilesAlreadyMigrated({
            fileId: file.id,
            audioRelativePaths,
            existingSongFiles,
            checkObjectExists: !dryRun
        });

        if (alreadyMigrated) {
            logger.info('Song files already nested; skipping', { fileId: file.id });
            return { fileId: file.id, skipped: true, items: [] };
        }

        const newStoragePaths = new Set(
            audioRelativePaths.map((relativePath) => spacesStorage.buildSongStorageKey(file.id, relativePath))
        );
        const legacyPaths = collectLegacyPathsToDelete({
            fileId: file.id,
            archivePath: archiveMeta.path,
            existingSongFiles,
            newStoragePaths
        });

        if (dryRun) {
            const items: SongFilesBackfillItemResult[] = [];
            for (const entry of audioEntries) {
                try {
                    const relativePath = normalizeRelativePath(entry.relativePath);
                    items.push({
                        relativePath,
                        storagePath: spacesStorage.buildSongStorageKey(file.id, relativePath),
                        size: entry.size,
                        deletedLegacyPaths: []
                    });
                } catch {
                    // skip unsafe paths (already logged above when building audioRelativePaths)
                }
            }

            // Attach planned legacy deletes to the first item for visibility (or empty list).
            if (items.length > 0) {
                items[0]!.deletedLegacyPaths = legacyPaths;
            } else if (legacyPaths.length > 0) {
                items.push({
                    relativePath: '(metadata-only cleanup)',
                    storagePath: '',
                    size: 0,
                    deletedLegacyPaths: legacyPaths
                });
            }

            return { fileId: file.id, skipped: false, items };
        }

        const updatedSongFiles: Record<string, SongMetadataEntry> = {};
        const items: SongFilesBackfillItemResult[] = [];

        for (const entry of audioEntries) {
            let relativePath: string;
            try {
                relativePath = normalizeRelativePath(entry.relativePath);
            } catch {
                continue;
            }

            const storagePath = spacesStorage.buildSongStorageKey(file.id, relativePath);
            const ext = path.extname(relativePath).toLowerCase().slice(1);
            const localPath = join(`song_${Date.now()}_${path.posix.basename(relativePath)}`);

            await archiveExtractEntry(archiveLocalPath, entry, localPath);
            try {
                const uploaded = await spacesStorage.uploadSongFiles(
                    [
                        {
                            sourcePath: localPath,
                            filename: relativePath,
                            size: entry.size,
                            type: ext
                        }
                    ],
                    file.id
                );
                const uploadedFile = uploaded.files[0];
                if (!uploadedFile) {
                    throw new Error(`Upload returned no result for ${relativePath}`);
                }

                updatedSongFiles[relativePath] = {
                    name: path.posix.basename(relativePath),
                    relativePath,
                    path: uploadedFile.path,
                    size: uploadedFile.size,
                    type: uploadedFile.type
                };

                items.push({
                    relativePath,
                    storagePath: uploadedFile.path,
                    size: uploadedFile.size,
                    deletedLegacyPaths: []
                });

                logger.info('Backfilled nested song object', {
                    fileId: file.id,
                    relativePath,
                    storagePath: uploadedFile.path,
                    size: uploadedFile.size
                });
            } finally {
                await fs.promises.unlink(localPath).catch(() => undefined);
            }
        }

        metadata.songFiles = updatedSongFiles;
        const { normalized } = normalizeLevelzipMetadata(metadata);
        await file.update({ metadata: normalized });

        const deletedLegacyPaths: string[] = [];
        for (const legacyPath of legacyPaths) {
            if (await spacesStorage.fileExists(legacyPath)) {
                await spacesStorage.deleteFile(legacyPath);
                deletedLegacyPaths.push(legacyPath);
                logger.info('Deleted legacy flat song object', {
                    fileId: file.id,
                    legacyPath
                });
            }
        }

        if (items.length > 0 && deletedLegacyPaths.length > 0) {
            items[0]!.deletedLegacyPaths = deletedLegacyPaths;
        } else if (items.length === 0 && deletedLegacyPaths.length > 0) {
            items.push({
                relativePath: '(metadata-only cleanup)',
                storagePath: '',
                size: 0,
                deletedLegacyPaths
            });
        }

        return { fileId: file.id, skipped: false, items };
    } finally {
        await fs.promises.unlink(archiveLocalPath).catch(() => undefined);
    }
}
