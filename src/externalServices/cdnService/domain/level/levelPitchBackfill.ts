import fs from 'fs';
import path from 'path';
import CdnFile from '@/models/cdn/CdnFile.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {
    archiveNameWithZipExtension,
    extractLevelPackPayload,
    getOriginalArchiveMeta,
    listEntries as archiveListEntries,
    updateArchiveMembers,
    type SupportedArchiveExt
} from '../../infra/archive/archiveService.js';
import {spacesStorage} from '../../infra/storage/spacesStorage.js';
import {
    buildLevelSourceStorageKey,
    downloadLevelToWorkspace,
    patchLevelEntrySourceFields,
    uploadLevelSourceObject,
    type LevelMetadataEntry
} from '../../infra/level/levelSourceBytes.js';
import {normalizeRelativePath, toSourceRelativePath} from '../archive/ingestPaths.js';
import {
    stripNonDefaultPitchFromSettingsRecord,
    stripNonDefaultPitchInLevelFile
} from './levelPitchNormalize.js';

export const PITCH_NORMALIZED_SEGMENT = 'pitch-normalized';

export function buildPitchNormalizedArchiveKey(fileId: string, filename: string): string {
    const base = path.posix.basename(filename.replace(/\\/g, '/'));
    return `zips/${fileId}/${PITCH_NORMALIZED_SEGMENT}/${base}`;
}

export function buildPitchNormalizedCanonicalKey(fileId: string, relativePath: string): string {
    return `levels/${fileId}/${PITCH_NORMALIZED_SEGMENT}/${normalizeRelativePath(relativePath)}`;
}

export type PitchBackfillHit = {
    relativePath: string;
    removedValue: unknown;
};

export type PitchBackfillResult = {
    fileId: string;
    status: 'skipped' | 'would-fix' | 'fixed';
    hits: PitchBackfillHit[];
    archiveKey?: string;
    canonicalKey?: string;
};

export type PitchBackfillOptions = {
    dryRun: boolean;
};

function cloneMetadata(metadata: unknown): Record<string, unknown> {
    return JSON.parse(JSON.stringify(metadata ?? {})) as Record<string, unknown>;
}

function posixNorm(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function isAdofaiRelativePath(relativePath: string): boolean {
    return relativePath.toLowerCase().endsWith('.adofai');
}

function forEachMatchingLevelEntry(
    metadata: Record<string, unknown>,
    relativePath: string,
    fn: (entry: LevelMetadataEntry) => void
): void {
    const normalized = normalizeRelativePath(relativePath);
    const allLevelFiles = Array.isArray(metadata.allLevelFiles)
        ? (metadata.allLevelFiles as LevelMetadataEntry[])
        : [];
    for (const entry of allLevelFiles) {
        if (!entry.relativePath) continue;
        if (normalizeRelativePath(String(entry.relativePath)) === normalized) {
            fn(entry);
        }
    }

    const levelFiles = metadata.levelFiles;
    if (!levelFiles || typeof levelFiles !== 'object' || Array.isArray(levelFiles)) {
        return;
    }
    const map = levelFiles as Record<string, LevelMetadataEntry>;
    for (const [key, entry] of Object.entries(map)) {
        const entryRel = entry?.relativePath ? normalizeRelativePath(String(entry.relativePath)) : '';
        if (normalizeRelativePath(key) === normalized || entryRel === normalized) {
            fn(entry);
        }
    }
}

function isTargetRelativePath(metadata: Record<string, unknown>, relativePath: string): boolean {
    const normalized = normalizeRelativePath(relativePath);
    const targetRel =
        typeof metadata.targetLevelRelativePath === 'string'
            ? posixNorm(metadata.targetLevelRelativePath)
            : '';
    if (targetRel && (targetRel === normalized || targetRel.endsWith(`/${normalized}`))) {
        return true;
    }
    const targetLevel = typeof metadata.targetLevel === 'string' ? posixNorm(metadata.targetLevel) : '';
    if (targetLevel && (targetLevel === normalized || targetLevel.endsWith(`/${normalized}`))) {
        return true;
    }
    return false;
}

function stripPitchFromCacheData(cacheData: string | null): {next: string | null; changed: boolean} {
    if (!cacheData) {
        return {next: cacheData, changed: false};
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(cacheData);
    } catch {
        return {next: cacheData, changed: false};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {next: cacheData, changed: false};
    }
    const rec = parsed as Record<string, unknown>;
    const settings =
        rec.settings && typeof rec.settings === 'object' && !Array.isArray(rec.settings)
            ? (rec.settings as Record<string, unknown>)
            : null;
    const stripped = stripNonDefaultPitchFromSettingsRecord(settings);
    if (!stripped.changed) {
        return {next: cacheData, changed: false};
    }
    return {next: JSON.stringify(parsed), changed: true};
}

async function retargetCanonicalIfNeeded(
    file: CdnFile,
    metadata: Record<string, unknown>,
    hit: PitchBackfillHit,
    extractRoot: string,
    join: (...parts: string[]) => string
): Promise<string | undefined> {
    const extractPath = path.join(extractRoot, hit.relativePath);
    let localForCanonical = extractPath;
    let shouldRetarget = true;
    const currentKey = typeof metadata.targetLevel === 'string' ? metadata.targetLevel : '';

    if (currentKey) {
        try {
            const downloaded = await downloadLevelToWorkspace(currentKey, join);
            const canonicalStrip = await stripNonDefaultPitchInLevelFile(downloaded.localPath);
            if (canonicalStrip.status === 'stripped') {
                localForCanonical = downloaded.localPath;
                logger.info('Stripped non-default pitch from canonical target chart', {
                    fileId: file.id,
                    relativePath: hit.relativePath,
                    removedValue: canonicalStrip.removedValue
                });
            } else if (canonicalStrip.status === 'unchanged') {
                shouldRetarget = false;
            }
        } catch (error) {
            logger.warn('Canonical target download failed; uploading stripped extract as new canonical', {
                fileId: file.id,
                currentKey,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    if (!shouldRetarget) {
        return undefined;
    }

    const newKey = buildPitchNormalizedCanonicalKey(file.id, hit.relativePath);
    const size = (await fs.promises.stat(localForCanonical)).size;
    await spacesStorage.uploadFile(localForCanonical, newKey, 'application/json', {
        fileId: file.id,
        uploadType: 'level',
        originalRelativePath: encodeURIComponent(hit.relativePath),
        uploadedAt: new Date().toISOString()
    });
    metadata.targetLevel = newKey;
    forEachMatchingLevelEntry(metadata, hit.relativePath, (entry) => {
        entry.path = newKey;
        entry.size = size;
    });
    return newKey;
}

/**
 * Find `.adofai` members whose `settings.pitch` is not 100% and rewrite the stored download
 * archive, source objects, and (when needed) the target canonical object.
 */
export async function backfillNonDefaultLevelPitchForZipRow(
    file: CdnFile,
    join: (...parts: string[]) => string,
    options: PitchBackfillOptions
): Promise<PitchBackfillResult> {
    const metadata = cloneMetadata(file.metadata);
    const archiveMeta = getOriginalArchiveMeta(metadata);
    if (!archiveMeta?.path) {
        throw new Error(`LEVELZIP ${file.id} has no originalArchive/originalZip path in metadata`);
    }

    const archiveLocalPath = join(`original_archive_${Date.now()}${archiveMeta.extension || '.zip'}`);
    await spacesStorage.downloadFileToPathStreaming(archiveMeta.path, archiveLocalPath);

    const hits: PitchBackfillHit[] = [];
    const extractRoot = join(`extract_${Date.now()}`);
    await fs.promises.mkdir(extractRoot, {recursive: true});

    try {
        const archiveEntries = await archiveListEntries(archiveLocalPath);
        const adofaiRels = archiveEntries
            .filter((entry) => !entry.isDirectory && isAdofaiRelativePath(entry.relativePath))
            .map((entry) => normalizeRelativePath(entry.relativePath));

        if (adofaiRels.length === 0) {
            throw new Error(`LEVELZIP ${file.id} has no .adofai members in the stored archive`);
        }

        await extractLevelPackPayload(archiveLocalPath, extractRoot, undefined, {
            requiredRelativePaths: adofaiRels
        });

        for (const relativePath of adofaiRels) {
            const localPath = path.join(extractRoot, relativePath);
            if (!fs.existsSync(localPath)) {
                logger.warn('Pitch backfill: level file missing after extract', {
                    fileId: file.id,
                    relativePath
                });
                continue;
            }

            const result = await stripNonDefaultPitchInLevelFile(localPath);
            if (result.status === 'stripped') {
                hits.push({relativePath, removedValue: result.removedValue});
                logger.info('Pitch backfill: stripped settings.pitch', {
                    fileId: file.id,
                    relativePath,
                    removedValue: result.removedValue,
                    dryRun: options.dryRun
                });
            } else if (result.status === 'skipped') {
                logger.warn('Pitch backfill: skipped chart', {
                    fileId: file.id,
                    relativePath,
                    reason: result.reason
                });
            }
        }

        if (hits.length === 0) {
            return {fileId: file.id, status: 'skipped', hits};
        }

        if (options.dryRun) {
            return {fileId: file.id, status: 'would-fix', hits};
        }

        const format = (archiveMeta.format || 'zip') as SupportedArchiveExt;
        const updatedArchive = await updateArchiveMembers({
            archivePath: archiveLocalPath,
            format,
            memberRoot: extractRoot,
            relativePaths: hits.map((hit) => hit.relativePath),
            workDir: path.dirname(extractRoot),
            archiveName: archiveMeta.name,
            signal: undefined
        });

        const storedName = updatedArchive.rebuiltAsZip
            ? archiveNameWithZipExtension(archiveMeta.name)
            : updatedArchive.name;
        const newArchiveKey = buildPitchNormalizedArchiveKey(file.id, storedName);
        await spacesStorage.uploadFile(
            updatedArchive.archivePath,
            newArchiveKey,
            updatedArchive.contentType,
            {
                fileId: file.id,
                originalFilename: encodeURIComponent(storedName),
                uploadType: 'archive',
                contentType: updatedArchive.contentType,
                uploadedAt: new Date().toISOString()
            }
        );

        const newArchiveMeta = {
            name: storedName,
            path: newArchiveKey,
            size: updatedArchive.size,
            originalFilename: storedName,
            format: updatedArchive.format,
            contentType: updatedArchive.contentType,
            extension: updatedArchive.extension
        };
        metadata.originalArchive = newArchiveMeta;
        metadata.originalZip = newArchiveMeta;

        const updates: {metadata: Record<string, unknown>; filePath?: string; cacheData?: string | null} = {
            metadata
        };
        if (file.filePath === archiveMeta.path) {
            updates.filePath = newArchiveKey;
        }

        for (const hit of hits) {
            const localPath = path.join(extractRoot, hit.relativePath);
            const size = (await fs.promises.stat(localPath)).size;
            let sourceKey: string | null = null;
            forEachMatchingLevelEntry(metadata, hit.relativePath, (entry) => {
                entry.size = size;
                if (typeof entry.sourcePath === 'string' && entry.sourcePath.length > 0 && !sourceKey) {
                    sourceKey = entry.sourcePath;
                }
            });
            sourceKey = sourceKey ?? buildLevelSourceStorageKey(file.id, hit.relativePath);
            const uploaded = await uploadLevelSourceObject(localPath, sourceKey, {
                fileId: file.id,
                originalRelativePath: hit.relativePath
            });
            forEachMatchingLevelEntry(metadata, hit.relativePath, (entry) => {
                patchLevelEntrySourceFields(entry, uploaded.path, toSourceRelativePath(hit.relativePath));
            });
        }

        let canonicalKey: string | undefined;
        const targetHit = hits.find((hit) => isTargetRelativePath(metadata, hit.relativePath));
        if (targetHit) {
            canonicalKey = await retargetCanonicalIfNeeded(file, metadata, targetHit, extractRoot, join);
        }

        const cacheUpdate = stripPitchFromCacheData(file.cacheData);
        if (cacheUpdate.changed) {
            updates.cacheData = cacheUpdate.next;
        }

        await file.update(updates);

        return {
            fileId: file.id,
            status: 'fixed',
            hits,
            archiveKey: newArchiveKey,
            canonicalKey
        };
    } finally {
        await fs.promises.unlink(archiveLocalPath).catch(() => undefined);
        await fs.promises.rm(extractRoot, {recursive: true, force: true}).catch(() => undefined);
    }
}
