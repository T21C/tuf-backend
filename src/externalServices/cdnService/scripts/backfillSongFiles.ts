#!/usr/bin/env npx tsx
/**
 * Backfill nested song objects for existing LEVELZIP rows by re-extracting audio
 * from the stored original archive and uploading under `zips/{fileId}/{relativePath}`.
 *
 * Rewrites `metadata.songFiles` (keyed by relative path) and deletes legacy
 * basename-only song objects. Does not change fileId or re-ingest charts.
 *
 * Usage (from `server/`):
 *   npx tsx src/externalServices/cdnService/scripts/backfillSongFiles.ts --dry-run --file-id <uuid>
 *   npx tsx src/externalServices/cdnService/scripts/backfillSongFiles.ts --file-id <uuid>
 *   npx tsx src/externalServices/cdnService/scripts/backfillSongFiles.ts --all --limit 50 --after-id <uuid>
 */

import { Command } from 'commander';
import dotenv from 'dotenv';
import { Op } from 'sequelize';

dotenv.config();

import { logger } from '@/server/services/core/LoggerService.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
import { CdnSpacesTempDomain, withCdnFileDomainWorkspace } from '../infra/workspaces/cdnSpacesTemp.js';
import { backfillSongFilesForZipRow } from '../domain/level/songFilesBackfill.js';

const cdnSequelize = getSequelizeForModelGroup('cdn');

const CDN_ZIP_FILE_ID_PARAM = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ScriptStats = {
    total: number;
    processed: number;
    successful: number;
    failed: number;
    skipped: number;
    songObjects: number;
    errors: Array<{ fileId: string; error: string }>;
};

async function processFile(
    fileId: string,
    options: { dryRun: boolean },
    stats: ScriptStats
): Promise<void> {
    if (!CDN_ZIP_FILE_ID_PARAM.test(fileId)) {
        stats.failed++;
        stats.errors.push({ fileId, error: 'Invalid fileId UUID' });
        stats.processed++;
        return;
    }

    const file = await CdnFile.findByPk(fileId);
    if (!file) {
        stats.failed++;
        stats.errors.push({ fileId, error: 'LEVELZIP row not found' });
        stats.processed++;
        return;
    }

    if (file.type !== 'LEVELZIP') {
        stats.skipped++;
        logger.warn(`Skipping non-LEVELZIP row: ${fileId} (${file.type})`);
        stats.processed++;
        return;
    }

    try {
        const result = await withCdnFileDomainWorkspace(
            CdnSpacesTempDomain.LevelCache,
            fileId,
            async ({ join }) =>
                backfillSongFilesForZipRow(file, join, {
                    dryRun: options.dryRun
                })
        );

        if (result.skipped) {
            stats.skipped++;
            logger.info(`Skipped already-nested songs for ${fileId}`);
        } else {
            stats.successful++;
            stats.songObjects += result.items.filter((item) => item.storagePath).length;
            logger.info(`Backfilled ${result.items.length} song item(s) for ${fileId}`, {
                items: result.items.map((item) => ({
                    relativePath: item.relativePath,
                    storagePath: item.storagePath,
                    size: item.size,
                    deletedLegacyPaths: item.deletedLegacyPaths
                }))
            });
        }
    } catch (error) {
        stats.failed++;
        const message = error instanceof Error ? error.message : String(error);
        stats.errors.push({ fileId, error: message });
        logger.error(`Failed to backfill songs for ${fileId}: ${message}`);
    }

    stats.processed++;
}

async function main(options: {
    dryRun: boolean;
    fileId?: string;
    all: boolean;
    limit?: number;
    afterId?: string;
}): Promise<boolean> {
    logger.info('Backfill nested song files from stored archives', options);

    let ok = true;
    const stats: ScriptStats = {
        total: 0,
        processed: 0,
        successful: 0,
        failed: 0,
        skipped: 0,
        songObjects: 0,
        errors: []
    };

    try {
        await cdnSequelize.authenticate();

        if (options.fileId) {
            stats.total = 1;
            await processFile(options.fileId, options, stats);
        } else if (options.all) {
            const pageSize = Math.max(50, options.limit ?? 100);
            let cursor = options.afterId;
            let remaining = options.limit ?? Number.MAX_SAFE_INTEGER;

            while (remaining > 0) {
                const where: Record<string, unknown> = { type: 'LEVELZIP' };
                if (cursor) {
                    where.id = { [Op.gt]: cursor };
                }

                const rows = await CdnFile.findAll({
                    where,
                    attributes: ['id'],
                    order: [['id', 'ASC']],
                    limit: Math.min(pageSize, remaining)
                });

                if (rows.length === 0) break;

                stats.total += rows.length;
                for (const row of rows) {
                    await processFile(row.id, options, stats);
                    remaining--;
                    if (remaining <= 0) break;
                }

                cursor = rows[rows.length - 1]!.id;
            }
        } else {
            logger.error('Specify --file-id <uuid> or --all');
            return false;
        }

        logger.info('Backfill complete', stats);
        if (options.dryRun) {
            logger.info('[DRY RUN] No storage uploads, deletes, or metadata writes were performed');
        }
        if (stats.errors.length > 0) {
            ok = false;
        }
    } catch (error) {
        ok = false;
        logger.error('Script failed', {
            error: error instanceof Error ? error.message : String(error)
        });
    } finally {
        await cdnSequelize.close();
    }

    return ok;
}

const program = new Command();

program
    .name('backfill-song-files')
    .description(
        'Re-extract audio from stored archives and upload nested song objects for LEVELZIP rows'
    )
    .option('-d, --dry-run', 'Preview nested keys without uploading, deleting, or updating metadata', false)
    .option('-f, --file-id <uuid>', 'Single LEVELZIP cdn_files.id')
    .option('--all', 'Process LEVELZIP rows in ascending id order', false)
    .option('--after-id <uuid>', 'Resume cursor when using --all')
    .option('-l, --limit <number>', 'Max rows to process', (value) => parseInt(value, 10))
    .action(async (opts) => {
        if (!opts.fileId && !opts.all) {
            console.error('Specify --file-id <uuid> or --all');
            process.exit(1);
        }
        if (opts.fileId && opts.all) {
            console.error('Use only one of --file-id or --all');
            process.exit(1);
        }

        const ok = await main({
            dryRun: opts.dryRun === true,
            fileId: typeof opts.fileId === 'string' ? opts.fileId.trim() : undefined,
            all: opts.all === true,
            limit: Number.isFinite(opts.limit) ? opts.limit : undefined,
            afterId: typeof opts.afterId === 'string' ? opts.afterId.trim() : undefined
        });
        process.exit(ok ? 0 : 1);
    });

program.parse(process.argv);
