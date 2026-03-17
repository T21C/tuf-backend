#!/usr/bin/env ts-node

import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import CdnFile from '@/models/cdn/CdnFile.js';
import { logger } from '@/server/services/LoggerService.js';
import { spacesStorage } from '../services/spacesStorage.js';
import { StorageType } from '../services/hybridStorageManager.js';
import { IMAGE_TYPES } from '../config.js';

type AnyRecord = Record<string, any>;

type CopySummary = {
    processed: number;
    migrated: number;
    copiedObjects: number;
    skippedObjects: number;
    failed: number;
    failures: Array<{ fileId: string; error: string }>;
};

type ComplianceReport = {
    totalChecked: number;
    compliant: number;
    missingFallbackMetadata: number;
    spacesPrimary: number;
    localPrimary: number;
    readChecks: {
        sampled: number;
        spacesPrimaryReadable: number;
        localFallbackReadable: number;
        failed: number;
    };
};

const IMAGE_TYPE_SET = new Set(Object.keys(IMAGE_TYPES));

function isAbsoluteLocalPath(value: unknown): value is string {
    return typeof value === 'string' && path.isAbsolute(value);
}

function getFirstExistingPath(paths: Array<string | undefined | null>): string | null {
    for (const p of paths) {
        if (!p) {
            continue;
        }
        if (isAbsoluteLocalPath(p) && fs.existsSync(p)) {
            return p;
        }
    }
    return null;
}

function sanitizeSegment(input: string): string {
    return input.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'item';
}

function normalizeRelativePath(relativePath: string): string {
    return relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

function toCopyRelativePath(relativePath: string): string {
    const normalized = normalizeRelativePath(relativePath);
    const parsed = path.posix.parse(normalized);
    return path.posix.join(parsed.dir, `${parsed.name}.copy`);
}

async function uploadIfNeeded(
    localPath: string,
    key: string,
    contentType?: string,
    dryRun = false
): Promise<'copied' | 'already_exists' | 'dry_run'> {
    if (dryRun) {
        return 'dry_run';
    }
    const exists = await spacesStorage.fileExists(key);
    if (exists) {
        return 'already_exists';
    }
    await spacesStorage.uploadFile(localPath, key, contentType);
    return 'copied';
}

function addFallbackRef(target: AnyRecord, localPath: string): void {
    target.fallbackPath = localPath;
    target.fallbackStorageType = StorageType.LOCAL;
}

function setSpacesPrimaryRef(target: AnyRecord, key: string): void {
    target.path = key;
    target.storageType = StorageType.SPACES;
}

async function migrateLevelZip(
    file: any,
    dryRun: boolean
): Promise<{ updated: boolean; copied: number; skipped: number }> {
    const metadata: AnyRecord = (file.metadata || {}) as AnyRecord;
    const fileId = file.id as string;
    let updated = false;
    let copied = 0;
    let skipped = 0;
    const levelPathMap = new Map<string, { key: string; fallback: string; relativePath?: string }>();

    // original zip
    const originalZip = metadata.originalZip as AnyRecord | undefined;
    if (originalZip?.name || originalZip?.path) {
        const localPath = getFirstExistingPath([originalZip?.fallbackPath, originalZip?.path]);
        if (localPath) {
            const filename = originalZip.originalFilename || originalZip.name || path.basename(localPath);
            const key = `zips/${fileId}/${filename}`;
            const state = await uploadIfNeeded(localPath, key, 'application/zip', dryRun);
            if (state === 'copied') copied++; else skipped++;
            setSpacesPrimaryRef(originalZip, key);
            addFallbackRef(originalZip, localPath);
            file.filePath = key;
            updated = true;
        }
    }

    // all level files
    const allLevelFiles = Array.isArray(metadata.allLevelFiles) ? metadata.allLevelFiles : [];
    for (const level of allLevelFiles) {
        if (!level?.name) continue;
        const localPath = getFirstExistingPath([level.fallbackPath, level.path]);
        if (!localPath) continue;
        const relativePath = level.relativePath
            ? normalizeRelativePath(String(level.relativePath))
            : sanitizeSegment(level.name);
        const key = `levels/${fileId}/${relativePath}`;
        const state = await uploadIfNeeded(localPath, key, 'application/json', dryRun);
        if (state === 'copied') copied++; else skipped++;
        const sourceCopyKey = `levels/${fileId}/${toCopyRelativePath(relativePath)}`;
        const sourceCopyState = await uploadIfNeeded(localPath, sourceCopyKey, 'application/octet-stream', dryRun);
        if (sourceCopyState === 'copied') copied++; else skipped++;

        levelPathMap.set(level.path, { key, fallback: localPath, relativePath });
        setSpacesPrimaryRef(level, key);
        addFallbackRef(level, localPath);
        level.relativePath = relativePath;
        level.sourceCopyPath = sourceCopyKey;
        level.sourceCopyStorageType = StorageType.SPACES;
        level.sourceCopyFallbackPath = localPath;
        level.sourceCopyFallbackStorageType = StorageType.LOCAL;
        updated = true;
    }

    // legacy levelFiles object
    if (metadata.levelFiles && typeof metadata.levelFiles === 'object') {
        for (const level of Object.values(metadata.levelFiles) as AnyRecord[]) {
            if (!level?.name) continue;
            const localPath = getFirstExistingPath([level.fallbackPath, level.path]);
            if (!localPath) continue;
            const relativePath = level.relativePath
                ? normalizeRelativePath(String(level.relativePath))
                : sanitizeSegment(level.name);
            const key = `levels/${fileId}/${relativePath}`;
            setSpacesPrimaryRef(level, key);
            addFallbackRef(level, localPath);
            level.relativePath = relativePath;
            level.sourceCopyPath = `levels/${fileId}/${toCopyRelativePath(relativePath)}`;
            level.sourceCopyStorageType = StorageType.SPACES;
            level.sourceCopyFallbackPath = localPath;
            level.sourceCopyFallbackStorageType = StorageType.LOCAL;
            updated = true;
        }
    }

    // songs
    const songFiles = metadata.songFiles && typeof metadata.songFiles === 'object'
        ? metadata.songFiles
        : {};
    for (const song of Object.values(songFiles) as AnyRecord[]) {
        if (!song?.name) continue;
        const localPath = getFirstExistingPath([song.fallbackPath, song.path]);
        if (!localPath) continue;
        const key = `zips/${fileId}/${song.name}`;
        const state = await uploadIfNeeded(localPath, key, undefined, dryRun);
        if (state === 'copied') copied++; else skipped++;
        setSpacesPrimaryRef(song, key);
        addFallbackRef(song, localPath);
        updated = true;
    }

    // targetLevel remap
    if (metadata.targetLevel && levelPathMap.has(metadata.targetLevel)) {
        const remap = levelPathMap.get(metadata.targetLevel)!;
        metadata.targetLevel = remap.key;
        metadata.targetLevelFallbackPath = remap.fallback;
        metadata.targetLevelFallbackStorageType = StorageType.LOCAL;
        if (remap.relativePath) {
            metadata.targetLevelRelativePath = remap.relativePath;
        }
        updated = true;
    }

    if (updated) {
        const updatedMetadata: AnyRecord = {
            storageType: StorageType.SPACES,
            levelStorageType: StorageType.SPACES,
            songStorageType: StorageType.SPACES,
            migratedToSpacesAt: new Date().toISOString(),
            migrationMode: 'copy_with_fallback'
        };
        if (!dryRun) {
            await file.update({
                filePath: file.filePath,
                metadata: {
                    ...metadata,
                    ...updatedMetadata
                }
            });
        }
    }

    return { updated, copied, skipped };
}

async function migrateImage(
    file: any,
    dryRun: boolean
): Promise<{ updated: boolean; copied: number; skipped: number }> {
    const metadata: AnyRecord = (file.metadata || {}) as AnyRecord;
    const fileId = file.id as string;
    const imageTypeKey = file.type as keyof typeof IMAGE_TYPES;
    const imageType = IMAGE_TYPES[imageTypeKey];
    if (!imageType) {
        return { updated: false, copied: 0, skipped: 0 };
    }

    let copied = 0;
    let skipped = 0;
    let updated = false;

    const variants = (metadata.variants && typeof metadata.variants === 'object') ? metadata.variants : {};
    const localDirectory = metadata.localDirectory || (isAbsoluteLocalPath(file.filePath) ? file.filePath : null);

    for (const variantName of Object.keys(imageType.sizes)) {
        const existing = variants[variantName] || {};
        const localPath = getFirstExistingPath([
            existing.fallbackPath,
            existing.path,
            localDirectory ? path.join(localDirectory, `${variantName}.png`) : null
        ]);
        if (!localPath) {
            continue;
        }
        const key = `images/${imageType.name}/${fileId}/${variantName}.png`;
        const state = await uploadIfNeeded(localPath, key, 'image/png', dryRun);
        if (state === 'copied') copied++; else skipped++;

        variants[variantName] = {
            ...existing,
            path: key,
            storageType: StorageType.SPACES,
            fallbackPath: localPath,
            fallbackStorageType: StorageType.LOCAL
        };
        updated = true;
    }

    if (updated) {
        const updatedMetadata: AnyRecord = {
            variants,
            storageType: StorageType.SPACES,
            imageStorageType: StorageType.SPACES,
            localDirectory,
            migratedToSpacesAt: new Date().toISOString(),
            migrationMode: 'copy_with_fallback'
        };
        file.filePath = variants.original?.path || file.filePath;
        if (!dryRun) {
            await file.update({
                filePath: file.filePath,
                metadata: {
                    ...metadata,
                    ...updatedMetadata
                }
            });
        }
    }

    return { updated, copied, skipped };
}

function collectPathRefs(root: unknown, refs: AnyRecord[] = []): AnyRecord[] {
    if (!root || typeof root !== 'object') return refs;
    if (Array.isArray(root)) {
        for (const item of root) collectPathRefs(item, refs);
        return refs;
    }
    const rec = root as AnyRecord;
    if (typeof rec.path === 'string') {
        refs.push(rec);
    }
    for (const value of Object.values(rec)) {
        collectPathRefs(value, refs);
    }
    return refs;
}

async function migrateGeneric(
    file: any,
    dryRun: boolean
): Promise<{ updated: boolean; copied: number; skipped: number }> {
    const metadata: AnyRecord = (file.metadata || {}) as AnyRecord;
    let copied = 0;
    let skipped = 0;
    let updated = false;
    const fileTypeSegment = sanitizeSegment(String(file.type || 'general').toLowerCase());
    const usedKeys = new Set<string>();

    const migrateRef = async (ref: AnyRecord, fallbackCandidates: string[]) => {
        const localPath = getFirstExistingPath(fallbackCandidates);
        if (!localPath) return;
        const base = sanitizeSegment(path.basename(localPath));
        let key = `files/${fileTypeSegment}/${file.id}/${base}`;
        let i = 1;
        while (usedKeys.has(key)) {
            key = `files/${fileTypeSegment}/${file.id}/${i}_${base}`;
            i++;
        }
        usedKeys.add(key);

        const state = await uploadIfNeeded(localPath, key, undefined, dryRun);
        if (state === 'copied') copied++; else skipped++;
        setSpacesPrimaryRef(ref, key);
        addFallbackRef(ref, localPath);
        updated = true;
    };

    const refs = collectPathRefs(metadata);
    for (const ref of refs) {
        await migrateRef(ref, [ref.fallbackPath, ref.path]);
    }

    // also migrate top-level filePath if it is still local
    if (isAbsoluteLocalPath(file.filePath)) {
        const topRef: AnyRecord = {
            path: file.filePath,
            fallbackPath: metadata.fallbackPath
        };
        await migrateRef(topRef, [topRef.fallbackPath, topRef.path]);
        if (topRef.path !== file.filePath) {
            file.filePath = topRef.path;
            metadata.fallbackPath = topRef.fallbackPath;
            metadata.fallbackStorageType = StorageType.LOCAL;
            updated = true;
        }
    }

    if (updated) {
        const updatedMetadata: AnyRecord = {
            storageType: StorageType.SPACES,
            migratedToSpacesAt: new Date().toISOString(),
            migrationMode: 'copy_with_fallback'
        };
        if (!dryRun) {
            await file.update({
                filePath: file.filePath,
                metadata: {
                    ...metadata,
                    ...updatedMetadata
                }
            });
        }
    }

    return { updated, copied, skipped };
}

export async function copyToSpacesWithFallback(
    batchSize = 100,
    fileType?: string,
    dryRun = false
): Promise<CopySummary> {
    const where: AnyRecord = {};
    if (fileType) {
        where.type = fileType;
    }

    const files = await CdnFile.findAll({
        where,
        limit: batchSize > 0 ? batchSize : undefined,
        order: [['createdAt', 'ASC']]
    });

    const summary: CopySummary = {
        processed: files.length,
        migrated: 0,
        copiedObjects: 0,
        skippedObjects: 0,
        failed: 0,
        failures: []
    };

    for (const file of files) {
        try {
            let result = { updated: false, copied: 0, skipped: 0 };
            if (file.type === 'LEVELZIP') {
                result = await migrateLevelZip(file, dryRun);
            } else if (IMAGE_TYPE_SET.has(file.type)) {
                result = await migrateImage(file, dryRun);
            } else {
                result = await migrateGeneric(file, dryRun);
            }

            if (result.updated) summary.migrated++;
            summary.copiedObjects += result.copied;
            summary.skippedObjects += result.skipped;
        } catch (error) {
            summary.failed++;
            summary.failures.push({
                fileId: file.id,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    return summary;
}

export async function getCopyToSpacesFallbackReport(sampleSize = 200): Promise<ComplianceReport> {
    const files = await CdnFile.findAll({
        limit: sampleSize,
        order: [['updatedAt', 'DESC']]
    });

    let compliant = 0;
    let missingFallbackMetadata = 0;
    let spacesPrimary = 0;
    let localPrimary = 0;
    let spacesPrimaryReadable = 0;
    let localFallbackReadable = 0;
    let failedReadChecks = 0;

    for (const file of files) {
        const metadata = (file.metadata || {}) as AnyRecord;
        const storageType = metadata.storageType || StorageType.SPACES;
        if (storageType === StorageType.SPACES) spacesPrimary++;
        if (storageType === StorageType.LOCAL) localPrimary++;

        let hasFallback = false;
        if (file.type === 'LEVELZIP') {
            hasFallback = !!metadata?.originalZip?.fallbackPath
                && !!metadata?.targetLevelFallbackPath;
        } else if (IMAGE_TYPE_SET.has(file.type)) {
            const variants = metadata?.variants || {};
            const values = Object.values(variants) as AnyRecord[];
            hasFallback = values.length > 0 && values.every(v => !!v.fallbackPath);
        } else {
            hasFallback = !!metadata?.fallbackPath
                || collectPathRefs(metadata).some(ref => !!ref.fallbackPath);
        }

        if (hasFallback) compliant++;
        else missingFallbackMetadata++;

        // lightweight read checks
        try {
            if (storageType === StorageType.SPACES && typeof file.filePath === 'string' && !path.isAbsolute(file.filePath)) {
                const ok = await spacesStorage.fileExists(file.filePath);
                if (ok) spacesPrimaryReadable++;
            }
            const localFallback = metadata?.fallbackPath;
            if (typeof localFallback === 'string' && path.isAbsolute(localFallback) && fs.existsSync(localFallback)) {
                localFallbackReadable++;
            }
        } catch {
            failedReadChecks++;
        }
    }

    return {
        totalChecked: files.length,
        compliant,
        missingFallbackMetadata,
        spacesPrimary,
        localPrimary,
        readChecks: {
            sampled: files.length,
            spacesPrimaryReadable,
            localFallbackReadable,
            failed: failedReadChecks
        }
    };
}

// Compatibility exports used by existing routes
export async function migrateStorageTypes(batchSize?: number, fileType?: string): Promise<void> {
    const result = await copyToSpacesWithFallback(batchSize || 100, fileType, false);
    logger.info('migrateStorageTypes completed', result);
}

export async function verifyMigration(): Promise<void> {
    const report = await getCopyToSpacesFallbackReport(200);
    logger.info('verifyMigration report', report);
}

export async function runBatchMigration(
    batchSize = 100,
    fileType?: string,
    maxBatches?: number
): Promise<void> {
    let batches = 0;
    while (!maxBatches || batches < maxBatches) {
        batches++;
        const result = await copyToSpacesWithFallback(batchSize, fileType, false);
        logger.info(`Batch ${batches} completed`, result);
        if (result.processed === 0) {
            break;
        }
        if (result.migrated === 0 && result.failed === 0) {
            break;
        }
    }
}

async function main(): Promise<void> {
    const program = new Command();

    program
        .name('migrate-storage-types')
        .description('Safe copy-only CDN migration to Spaces with local fallback metadata')
        .version('2.0.0');

    program
        .command('copy-to-spaces')
        .description('Copy local files to Spaces and set fallback metadata')
        .option('-b, --batch-size <number>', 'Number of files to process', '100')
        .option('-t, --file-type <type>', 'Optional file type filter')
        .option('--dry-run', 'Preview migration without changes')
        .action(async (options) => {
            const batchSize = parseInt(options.batchSize, 10);
            const result = await copyToSpacesWithFallback(batchSize, options.fileType, !!options.dryRun);
            console.log(JSON.stringify(result, null, 2));
            process.exit(0);
        });

    program
        .command('copy-to-spaces-report')
        .description('Report fallback metadata compliance and sample read checks')
        .option('-s, --sample-size <number>', 'Number of rows to inspect', '200')
        .action(async (options) => {
            const sampleSize = parseInt(options.sampleSize, 10);
            const report = await getCopyToSpacesFallbackReport(sampleSize);
            console.log(JSON.stringify(report, null, 2));
            process.exit(0);
        });

    program
        .command('migrate')
        .description('Compatibility alias for copy-to-spaces')
        .option('-b, --batch-size <number>', 'Number of files to process', '100')
        .option('-t, --file-type <type>', 'Optional file type filter')
        .action(async (options) => {
            await migrateStorageTypes(parseInt(options.batchSize, 10), options.fileType);
            await verifyMigration();
            process.exit(0);
        });

    await program.parseAsync();
}

main().catch((error) => {
    logger.error('Migration script failed', {
        error: error instanceof Error ? error.message : String(error)
    });
    process.exit(1);
});

