import fs from 'fs';
import { logger } from '@/server/services/core/LoggerService.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import { getOriginalArchiveMeta } from '../../infra/archive/archiveService.js';
import { spacesStorage } from '../../infra/storage/spacesStorage.js';
import { normalizeRelativePath, toSourceRelativePath } from '../archive/ingestPaths.js';
import {
    buildLegacyLevelCopyStorageKey,
    buildLevelSourceStorageKey,
    extractLevelBytesFromArchive,
    patchLevelEntrySourceFields,
    type LevelMetadataEntry,
    uploadLevelSourceObject
} from '../../infra/level/levelSourceBytes.js';
import { listEntries as archiveListEntries } from '../../infra/archive/archiveService.js';

export type LevelSourceBackfillItemResult = {
    relativePath: string;
    sourcePath: string;
    sourceSize: number;
    deletedLegacyCopyPath?: string;
};

export type LevelSourceBackfillResult = {
    fileId: string;
    items: LevelSourceBackfillItemResult[];
};

export type LevelSourceBackfillOptions = {
    /** When set, only backfill this level relative path (defaults to all entries in the pack). */
    targetRelativePath?: string;
    /** Remove legacy `*.copy` objects after a successful `.source` upload. */
    deleteLegacyCopy?: boolean;
    dryRun?: boolean;
};

function cloneMetadata(metadata: unknown): Record<string, unknown> {
    return JSON.parse(JSON.stringify(metadata ?? {})) as Record<string, unknown>;
}

function syncLevelFilesMap(
    metadata: Record<string, unknown>,
    allLevelFiles: LevelMetadataEntry[]
): void {
    const levelFiles = metadata.levelFiles;
    if (!levelFiles || typeof levelFiles !== 'object' || Array.isArray(levelFiles)) {
        return;
    }

    for (const entry of allLevelFiles) {
        if (!entry.relativePath) continue;
        const key = entry.relativePath;
        const altKey = normalizeRelativePath(key);
        const map = levelFiles as Record<string, LevelMetadataEntry>;
        if (map[key]) {
            Object.assign(map[key], entry);
        } else if (map[altKey]) {
            Object.assign(map[altKey], entry);
        }
    }
}

function selectLevelEntries(metadata: Record<string, unknown>, targetRelativePath?: string): LevelMetadataEntry[] {
    const allLevelFiles = Array.isArray(metadata.allLevelFiles)
        ? (metadata.allLevelFiles as LevelMetadataEntry[])
        : [];

    if (!targetRelativePath) {
        return allLevelFiles.filter((entry) => !!entry.relativePath);
    }

    const normalizedTarget = normalizeRelativePath(targetRelativePath);
    return allLevelFiles.filter(
        (entry) => entry.relativePath && normalizeRelativePath(String(entry.relativePath)) === normalizedTarget
    );
}

/**
 * Re-extract .adofai bytes from the stored original archive and upload them as immutable `.source` objects.
 * Does not re-ingest the pack or rewrite canonical level JSON.
 */
export async function backfillLevelSourcesForZipRow(
    file: CdnFile,
    join: (...parts: string[]) => string,
    options: LevelSourceBackfillOptions = {}
): Promise<LevelSourceBackfillResult> {
    const metadata = cloneMetadata(file.metadata);
    const archiveMeta = getOriginalArchiveMeta(metadata);
    if (!archiveMeta?.path) {
        throw new Error(`LEVELZIP ${file.id} has no originalArchive/originalZip path in metadata`);
    }

    const levelEntries = selectLevelEntries(metadata, options.targetRelativePath);
    if (levelEntries.length === 0) {
        throw new Error(
            options.targetRelativePath
                ? `No allLevelFiles entry for relative path: ${options.targetRelativePath}`
                : `LEVELZIP ${file.id} has no allLevelFiles entries`
        );
    }

    const results: LevelSourceBackfillItemResult[] = [];

    if (options.dryRun) {
        for (const entry of levelEntries) {
            const relativePath = normalizeRelativePath(String(entry.relativePath));
            const sourcePath = buildLevelSourceStorageKey(file.id, relativePath);
            const legacyCopyPath = buildLegacyLevelCopyStorageKey(file.id, relativePath);
            results.push({
                relativePath,
                sourcePath,
                sourceSize: entry.size ?? 0,
                deletedLegacyCopyPath: options.deleteLegacyCopy ? legacyCopyPath : undefined
            });
        }
        return { fileId: file.id, items: results };
    }

    const archiveLocalPath = join(`original_archive_${Date.now()}${archiveMeta.extension || '.zip'}`);
    await spacesStorage.downloadFileToPathStreaming(archiveMeta.path, archiveLocalPath);

    try {
        const archiveEntries = await archiveListEntries(archiveLocalPath);

        for (const entry of levelEntries) {
            const relativePath = normalizeRelativePath(String(entry.relativePath));
            const sourceRelativePath = toSourceRelativePath(relativePath);
            const sourceStorageKey = buildLevelSourceStorageKey(file.id, relativePath);
            const legacyCopyKey = buildLegacyLevelCopyStorageKey(file.id, relativePath);

            const extracted = await extractLevelBytesFromArchive({
                metadata,
                levelEntry: entry,
                join,
                archiveLocalPath,
                archiveEntries
            });

            if (!extracted) {
                throw new Error(`Failed to extract ${relativePath} from archive for fileId=${file.id}`);
            }

            try {
                const uploaded = await uploadLevelSourceObject(extracted.localPath, sourceStorageKey, {
                    fileId: file.id,
                    originalRelativePath: relativePath
                });

                patchLevelEntrySourceFields(entry, uploaded.path, sourceRelativePath);

                let deletedLegacyCopyPath: string | undefined;
                if (options.deleteLegacyCopy && (await spacesStorage.fileExists(legacyCopyKey))) {
                    await spacesStorage.deleteFile(legacyCopyKey);
                    deletedLegacyCopyPath = legacyCopyKey;
                }

                results.push({
                    relativePath,
                    sourcePath: uploaded.path,
                    sourceSize: uploaded.size,
                    deletedLegacyCopyPath
                });

                logger.info('Backfilled level source object', {
                    fileId: file.id,
                    relativePath,
                    sourcePath: uploaded.path,
                    sourceSize: uploaded.size,
                    deletedLegacyCopyPath
                });
            } finally {
                await fs.promises.unlink(extracted.localPath).catch(() => undefined);
            }
        }

        syncLevelFilesMap(metadata, metadata.allLevelFiles as LevelMetadataEntry[]);
        await file.update({ metadata });

        return { fileId: file.id, items: results };
    } finally {
        await fs.promises.unlink(archiveLocalPath).catch(() => undefined);
    }
}
