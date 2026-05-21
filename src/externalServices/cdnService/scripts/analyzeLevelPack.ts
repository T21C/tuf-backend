#!/usr/bin/env npx tsx
/**
 * Manually analyze one level pack (local archive, CDN file id, or site level id) and print
 * ingest-style metadata + per-file diagnostics for edge-case debugging.
 *
 * Does not upload, mutate `cdn_files`, or refresh cache.
 *
 * Usage (from server/):
 *   npx tsx src/externalServices/cdnService/scripts/analyzeLevelPack.ts --zip "C:\samples\weird-encoding.zip"
 *   npx tsx src/externalServices/cdnService/scripts/analyzeLevelPack.ts --file-id <uuid>
 *   npx tsx src/externalServices/cdnService/scripts/analyzeLevelPack.ts --level-id 9611
 *   npx tsx src/externalServices/cdnService/scripts/analyzeLevelPack.ts --zip ./edge.adofai --target "sub/level.adofai"
 *   npx tsx src/externalServices/cdnService/scripts/analyzeLevelPack.ts --file-id <uuid> --compare-db
 *   npx tsx src/externalServices/cdnService/scripts/analyzeLevelPack.ts --zip ./big.zip --list-only
 *
 * Output: JSON on stdout (metadata under `proposedMetadata`; use `--metadata-only` for that subtree).
 */

import { Command } from 'commander';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

import Level from '@/models/levels/Level.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
import { initializeAssociations } from '@/models/associations.js';
import { withWorkspace } from '@/server/services/core/WorkspaceService.js';
import { spacesStorage } from '../infra/storage/spacesStorage.js';
import { getOriginalArchiveMeta } from '../infra/archive/archiveService.js';
import { analyzeLevelPackArchive } from '../domain/level/levelPackAnalysis.js';
import { auditLevelzipMetadataForMojibake } from '../domain/metadata/mojibakeAuditLevelzipMetadata.js';
import { computeLevelCacheMetadataSignature } from '../domain/level/levelCacheSignature.js';
import { CdnSpacesTempDomain } from '../infra/workspaces/cdnSpacesTemp.js';

initializeAssociations();

const levelsSequelize = getSequelizeForModelGroup('levels');
const cdnSequelize = getSequelizeForModelGroup('cdn');

const CDN_ZIP_FILE_ID_PARAM =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ScriptOutput = {
    input: {
        mode: 'zip' | 'file-id' | 'level-id';
        levelId?: number;
        fileId?: string;
        zipPath?: string;
    };
    persisted?: {
        fileId: string;
        metadata: unknown;
        cacheMetadataSignature: string;
        mojibakeHitCount: number;
        mojibakeHits?: ReturnType<typeof auditLevelzipMetadataForMojibake>;
    };
    analysis: Awaited<ReturnType<typeof analyzeLevelPackArchive>>;
    compare?: {
        targetLevelMatches: boolean;
        targetLevelOversizedMatches: boolean;
        proposedMojibakeHitCount: number;
    };
};

async function resolveFileIdFromLevelId(levelId: number): Promise<string> {
    const level = await Level.findByPk(levelId, { attributes: ['id', 'fileId'] });
    if (!level) {
        throw new Error(`Level ${levelId} not found`);
    }
    if (!level.fileId) {
        throw new Error(`Level ${levelId} has no fileId`);
    }
    return level.fileId;
}

async function resolveStoredArchiveDescriptor(fileId: string): Promise<{
    storagePath: string;
    originalFilename: string;
}> {
    if (!CDN_ZIP_FILE_ID_PARAM.test(fileId)) {
        throw new Error(`Invalid file id UUID: ${fileId}`);
    }

    const file = await CdnFile.findOne({
        where: { id: fileId, type: 'LEVELZIP' },
        attributes: ['id', 'metadata']
    });
    if (!file) {
        throw new Error(`No LEVELZIP cdn_files row for ${fileId}`);
    }

    const meta = getOriginalArchiveMeta(file.metadata);
    if (!meta?.path) {
        throw new Error(`LEVELZIP ${fileId} has no originalArchive/originalZip path in metadata`);
    }

    const exists = await spacesStorage.fileExists(meta.path);
    if (!exists) {
        throw new Error(`Archive not found in storage: ${meta.path}`);
    }

    return {
        storagePath: meta.path,
        originalFilename: meta.originalFilename || meta.name || `${fileId}.zip`
    };
}

async function main(): Promise<void> {
    const program = new Command();
    program
        .name('analyze-level-pack')
        .description('Dry-run level pack analysis with proposed LEVELZIP metadata (no writes)')
        .option('--zip <path>', 'Local .zip / .rar / .7z / .tar archive')
        .option('--file-id <uuid>', 'Download and analyze stored LEVELZIP by cdn_files.id')
        .option('--level-id <id>', 'Resolve fileId from levels row', (v) => parseInt(v, 10))
        .option('--target <relativePath>', 'Force target .adofai relative path inside archive')
        .option('--list-only', 'List archive entries only (skip extract + parse)', false)
        .option('--compare-db', 'Include persisted metadata + diff hints (requires --file-id or --level-id)', false)
        .option('--metadata-only', 'Print only proposedMetadata JSON', false)
        .parse();

    const opts = program.opts<{
        zip?: string;
        fileId?: string;
        levelId?: number;
        target?: string;
        listOnly?: boolean;
        compareDb?: boolean;
        metadataOnly?: boolean;
    }>();

    const hasZip = Boolean(opts.zip?.trim());
    const hasFileId = Boolean(opts.fileId?.trim());
    const hasLevelId = Number.isFinite(opts.levelId);

    const sourceCount = [hasZip, hasFileId, hasLevelId].filter(Boolean).length;
    if (sourceCount !== 1) {
        // eslint-disable-next-line no-console
        console.error('Provide exactly one of: --zip, --file-id, --level-id');
        process.exit(1);
    }

    if (opts.compareDb && hasZip) {
        // eslint-disable-next-line no-console
        console.error('--compare-db requires --file-id or --level-id');
        process.exit(1);
    }

    let mode: ScriptOutput['input']['mode'];
    let fileId: string | undefined;
    let zipPath: string | undefined;
    let levelId: number | undefined;
    let localArchivePath: string;
    let originalFilename: string;

    try {
        await levelsSequelize.authenticate();
        await cdnSequelize.authenticate();

        let storagePath: string | undefined;

        if (hasZip) {
            mode = 'zip';
            zipPath = path.resolve(opts.zip!.trim());
            if (!fs.existsSync(zipPath)) {
                throw new Error(`Archive not found: ${zipPath}`);
            }
            localArchivePath = zipPath;
            originalFilename = path.basename(zipPath);
            fileId = opts.fileId?.trim() || undefined;
        } else if (hasLevelId) {
            mode = 'level-id';
            levelId = opts.levelId;
            fileId = await resolveFileIdFromLevelId(levelId!);
            const descriptor = await resolveStoredArchiveDescriptor(fileId);
            storagePath = descriptor.storagePath;
            originalFilename = descriptor.originalFilename;
            localArchivePath = '';
        } else {
            mode = 'file-id';
            fileId = opts.fileId!.trim();
            const descriptor = await resolveStoredArchiveDescriptor(fileId);
            storagePath = descriptor.storagePath;
            originalFilename = descriptor.originalFilename;
            localArchivePath = '';
        }

        const runAnalysis = async (workspaceDir: string) => {
            let archivePath = localArchivePath;
            if (storagePath) {
                const ext = path.extname(originalFilename) || '.zip';
                archivePath = path.join(workspaceDir, `source${ext}`);
                await spacesStorage.downloadFileToPathStreaming(storagePath, archivePath);
            }
            return analyzeLevelPackArchive(archivePath, workspaceDir, {
                skipExtract: opts.listOnly === true,
                forceTargetRelativePath: opts.target?.trim() || undefined,
                fileId,
                originalFilename
            });
        };

        const analysis = await withWorkspace(CdnSpacesTempDomain.LevelsRouteMisc, (ws) => runAnalysis(ws.dir));

        const output: ScriptOutput = {
            input: { mode, levelId, fileId, zipPath },
            analysis
        };

        if (opts.compareDb && fileId) {
            const row = await CdnFile.findOne({
                where: { id: fileId, type: 'LEVELZIP' },
                attributes: ['id', 'metadata']
            });
            if (row?.metadata) {
                const persisted = row.metadata as Record<string, unknown>;
                const mojibakeHits = auditLevelzipMetadataForMojibake(persisted);
                output.persisted = {
                    fileId,
                    metadata: persisted,
                    cacheMetadataSignature: computeLevelCacheMetadataSignature(persisted),
                    mojibakeHitCount: mojibakeHits.length,
                    mojibakeHits: mojibakeHits.length > 0 ? mojibakeHits.slice(0, 40) : undefined
                };
                output.compare = {
                    targetLevelMatches: persisted.targetLevel === analysis.proposedMetadata.targetLevel,
                    targetLevelOversizedMatches:
                        Boolean(persisted.targetLevelOversized) ===
                        analysis.proposedMetadata.targetLevelOversized,
                    proposedMojibakeHitCount: auditLevelzipMetadataForMojibake(
                        analysis.proposedMetadata
                    ).length
                };
            }
        }

        const text = opts.metadataOnly
            ? JSON.stringify(analysis.proposedMetadata, null, 2)
            : JSON.stringify(output, null, 2);
        // eslint-disable-next-line no-console
        console.log(text);
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
            error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
    } finally {
        await levelsSequelize.close().catch(() => undefined);
        await cdnSequelize.close().catch(() => undefined);
    }
}

main();
