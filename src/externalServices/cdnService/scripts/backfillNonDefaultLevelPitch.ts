#!/usr/bin/env npx tsx
/**
 * Scan LEVELZIP original archives for `.adofai` charts whose `settings.pitch` is not 100%
 * (forgotten editor playback speed) and rewrite the stored download so players receive 100%.
 *
 * Default is dry-run. Pass `--apply` to upload a new immutable archive object, retarget
 * `originalZip` / `originalArchive`, overwrite `.source` objects, and retarget the canonical
 * target chart when it still carries a non-100 pitch.
 *
 * Usage (from `server/`):
 *   npx tsx src/externalServices/cdnService/scripts/backfillNonDefaultLevelPitch.ts --file-id <uuid>
 *   npx tsx src/externalServices/cdnService/scripts/backfillNonDefaultLevelPitch.ts --all --limit 50
 *   npx tsx src/externalServices/cdnService/scripts/backfillNonDefaultLevelPitch.ts --all --apply --after-id <uuid>
 *
 * Host (CDN container — has cdn.env, Spaces, 7z, cdn-temp volume):
 *   sudo docker compose --env-file /srv/tuf/config/stack.env \
 *     -f /srv/tuf/infra/compose.yml run --rm --no-deps cdn \
 *     node dist/externalServices/cdnService/scripts/backfillNonDefaultLevelPitch.js --all --limit 50
 *
 *   sudo docker compose --env-file /srv/tuf/config/stack.env \
 *     -f /srv/tuf/infra/compose.yml run --rm --no-deps cdn \
 *     node dist/externalServices/cdnService/scripts/backfillNonDefaultLevelPitch.js --all --apply --after-id <uuid>
 */

import {Command} from 'commander';
import dotenv from 'dotenv';
import {Op} from 'sequelize';

dotenv.config();

import {logger} from '@/server/services/core/LoggerService.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import {getSequelizeForModelGroup} from '@/config/db.js';
import {CdnSpacesTempDomain, withCdnFileDomainWorkspace} from '../infra/workspaces/cdnSpacesTemp.js';
import {backfillNonDefaultLevelPitchForZipRow} from '../domain/level/levelPitchBackfill.js';

const cdnSequelize = getSequelizeForModelGroup('cdn');

const CDN_ZIP_FILE_ID_PARAM = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ScriptStats = {
    total: number;
    processed: number;
    skipped: number;
    wouldFix: number;
    fixed: number;
    failed: number;
    hits: number;
    errors: Array<{fileId: string; error: string}>;
};

async function processFile(
    fileId: string,
    options: {dryRun: boolean},
    stats: ScriptStats
): Promise<void> {
    if (!CDN_ZIP_FILE_ID_PARAM.test(fileId)) {
        stats.failed++;
        stats.errors.push({fileId, error: 'Invalid fileId UUID'});
        stats.processed++;
        return;
    }

    const file = await CdnFile.findByPk(fileId);
    if (!file) {
        stats.failed++;
        stats.errors.push({fileId, error: 'LEVELZIP row not found'});
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
            async ({join}) =>
                backfillNonDefaultLevelPitchForZipRow(file, join, {
                    dryRun: options.dryRun
                })
        );

        stats.hits += result.hits.length;
        if (result.status === 'skipped') {
            stats.skipped++;
            logger.info(`No non-default pitch in ${fileId}`);
        } else if (result.status === 'would-fix') {
            stats.wouldFix++;
            logger.info(`Would strip non-default pitch in ${fileId}`, {
                hits: result.hits
            });
        } else {
            stats.fixed++;
            logger.info(`Stripped non-default pitch in ${fileId}`, {
                hits: result.hits,
                archiveKey: result.archiveKey,
                canonicalKey: result.canonicalKey
            });
        }
    } catch (error) {
        stats.failed++;
        const message = error instanceof Error ? error.message : String(error);
        stats.errors.push({fileId, error: message});
        logger.error(`Failed pitch backfill for ${fileId}: ${message}`);
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
    logger.info('Backfill non-default settings.pitch in LEVELZIP archives', options);

    let ok = true;
    const stats: ScriptStats = {
        total: 0,
        processed: 0,
        skipped: 0,
        wouldFix: 0,
        fixed: 0,
        failed: 0,
        hits: 0,
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
                const where: Record<string, unknown> = {type: 'LEVELZIP'};
                if (cursor) {
                    where.id = {[Op.gt]: cursor};
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

        logger.info('Pitch backfill complete', stats);
        if (options.dryRun) {
            logger.info('[DRY RUN] No storage uploads or metadata writes were performed');
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
    .name('backfill-non-default-level-pitch')
    .description(
        'Strip settings.pitch other than 100% from LEVELZIP original archives and republish downloads'
    )
    .option('--apply', 'Upload rewritten archives and update metadata. Default: dry-run', false)
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
            dryRun: opts.apply !== true,
            fileId: typeof opts.fileId === 'string' ? opts.fileId.trim() : undefined,
            all: opts.all === true,
            limit: Number.isFinite(opts.limit) ? opts.limit : undefined,
            afterId: typeof opts.afterId === 'string' ? opts.afterId.trim() : undefined
        });
        process.exit(ok ? 0 : 1);
    });

program.parse(process.argv);
