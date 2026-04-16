#!/usr/bin/env ts-node

/**
 * Walk levels (by id), resolve CDN zip UUID from each level's dlLink, refresh LEVELZIP
 * cache only when metadata is stale or missing, then always sync chart stats to the level
 * row, Elasticsearch, and HTTP cache tags.
 *
 * Skips orphaned dlLinks (no LEVELZIP row), oversized targets, and non-CDN links.
 *
 * Usage (from server/):
 *   npx tsx src/externalServices/cdnService/scripts/forceRefreshLevelCache.ts --dry-run
 *   npx tsx src/externalServices/cdnService/scripts/forceRefreshLevelCache.ts --level-id 9611
 *   npx tsx src/externalServices/cdnService/scripts/forceRefreshLevelCache.ts --after-id 0 --limit 200 --concurrency 4
 */

import { Command } from 'commander';
import dotenv from 'dotenv';
import { Op } from 'sequelize';

dotenv.config();

import { logger } from '@/server/services/core/LoggerService.js';
import Level from '@/models/levels/Level.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
import { isCdnUrl } from '@/misc/utils/Utility.js';
import { applyLevelChartStatsFromCdn } from '@/misc/utils/data/levelChartStatsSync.js';
import { initializeAssociations } from '@/models/associations.js';
import { levelCacheService, SAFE_TO_PARSE_VERSION } from '../services/levelCacheService.js';

initializeAssociations();

const levelsSequelize = getSequelizeForModelGroup('levels');
const cdnSequelize = getSequelizeForModelGroup('cdn');

interface ScriptStats {
    total: number;
    processed: number;
    successful: number;
    failed: number;
    skipped: number;
    errors: Array<{ levelId: number; fileId?: string; error: string }>;
}

function needsMetadataParseRefresh(file: CdnFile): boolean {
    const metadata = file.metadata as {
        targetSafeToParse?: boolean;
        targetSafeToParseVersion?: number;
    } | null;
    const safeToParse = metadata?.targetSafeToParse === true;
    const storedVersion = metadata?.targetSafeToParseVersion;
    return !safeToParse || storedVersion !== SAFE_TO_PARSE_VERSION;
}

/** Re-parse zip when forced, cache missing, or safe-to-parse metadata is outdated. */
function shouldRebuildZipCache(file: CdnFile, forceCacheRebuild: boolean): boolean {
    if (forceCacheRebuild) return true;
    if (file.cacheData == null) return true;
    return needsMetadataParseRefresh(file);
}

async function mapWithConcurrency<T>(
    items: readonly T[],
    concurrency: number,
    fn: (item: T, idx: number) => Promise<void>
): Promise<void> {
    if (items.length === 0) return;
    const n = Math.min(Math.max(1, concurrency), items.length);
    let index = 0;
    const worker = async () => {
        while (true) {
            const i = index++;
            if (i >= items.length) return;
            await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: n }, () => worker()));
}

function positionLabel(position: number, totalLabel: string): string {
    return totalLabel === '—' ? `[${position}]` : `[${position}/${totalLabel}]`;
}

async function processLevel(
    levelId: number,
    options: { dryRun: boolean; forceCacheRebuild: boolean },
    stats: ScriptStats,
    position: number,
    totalLabel: string
): Promise<void> {
    const label = positionLabel(position, totalLabel);
    const level = await Level.findByPk(levelId, { attributes: ['id', 'dlLink', 'fileId'] });
    if (!level) {
        stats.skipped++;
        logger.warn(`${label} Level ${levelId}: not found`);
        stats.processed++;
        return;
    }

    if (!level.dlLink || !isCdnUrl(level.dlLink)) {
        stats.skipped++;
        logger.info(`${label} Level ${levelId}: skip (no CDN dlLink)`);
        stats.processed++;
        return;
    }

    const fileId = level.fileId ?? null;
    if (!fileId) {
        stats.skipped++;
        logger.info(`${label} Level ${levelId}: skip (no fileId on level row)`);
        stats.processed++;
        return;
    }

    const file = await CdnFile.findByPk(fileId);
    if (!file || file.type !== 'LEVELZIP') {
        stats.skipped++;
        stats.errors.push({
            levelId,
            fileId,
            error: !file ? 'orphan dlLink (no CDN row)' : `not a LEVELZIP (type=${file.type})`
        });
        logger.warn(`${label} Level ${levelId}: orphan or bad file ${fileId}`);
        stats.processed++;
        return;
    }

    const metadata = file.metadata as { targetLevelOversized?: boolean } | undefined;
    if (metadata?.targetLevelOversized) {
        stats.skipped++;
        logger.warn(`${label} Level ${levelId}: oversized target — ${fileId}`);
        stats.processed++;
        return;
    }

    const rebuild = shouldRebuildZipCache(file, options.forceCacheRebuild);

    if (options.dryRun) {
        logger.info(
            `[DRY RUN] ${label} level=${levelId} file=${fileId} rebuildZipCache=${rebuild} wouldRunChartSync=true`
        );
        stats.skipped++;
        stats.processed++;
        return;
    }

    try {
        if (rebuild) {
            logger.info(`${label} Rebuilding CDN cache for level ${levelId} (file ${fileId})`);
            await levelCacheService.clearCache(file);
            const cacheData = await levelCacheService.ensureCachePopulated(file.id);
            if (!cacheData) {
                stats.failed++;
                stats.errors.push({ levelId, fileId, error: 'ensureCachePopulated returned null' });
                logger.error(`${label} Level ${levelId}: cache repopulate failed (${fileId})`);
                stats.processed++;
                return;
            }
        }

        await applyLevelChartStatsFromCdn(levelId);
        stats.successful++;
        logger.info(`${label} Level ${levelId}: chart stats + ES + cache OK`);
    } catch (error) {
        stats.failed++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        stats.errors.push({ levelId, fileId, error: errorMessage });
        logger.error(`${label} Level ${levelId}:`, { fileId, error: errorMessage });
    }

    stats.processed++;
}

async function main(options: {
    dryRun: boolean;
    limit?: number;
    afterId: number;
    concurrency: number;
    batchSize: number;
    levelId?: number;
    forceCacheRebuild: boolean;
}): Promise<boolean> {
    logger.info('Force-refresh level cache (level-driven)', {
        ...options,
        safeToParseVersion: SAFE_TO_PARSE_VERSION
    });

    let ok = true;
    try {
        await levelsSequelize.authenticate();
        await cdnSequelize.authenticate();
        logger.info('Database connections established (levels + cdn)');

        const stats: ScriptStats = {
            total: 0,
            processed: 0,
            successful: 0,
            failed: 0,
            skipped: 0,
            errors: []
        };

        if (options.levelId !== undefined) {
            stats.total = 1;
            await processLevel(options.levelId, options, stats, 1, '1');
        } else {
            const maxTotal = options.limit ?? Number.MAX_SAFE_INTEGER;
            let done = 0;
            let afterId = options.afterId;
            const FETCH = Math.max(500, options.batchSize);
            const totalLabel = options.limit !== undefined ? String(options.limit) : '—';

            while (done < maxTotal) {
                const rows = await Level.findAll({
                    where: { id: { [Op.gt]: afterId } },
                    attributes: ['id', 'dlLink', 'fileId'],
                    order: [['id', 'ASC']],
                    limit: FETCH
                });

                if (rows.length === 0) break;

                afterId = rows[rows.length - 1]!.id;

                const cdnLinked = rows.filter((row) => {
                    const dl = row.dlLink;
                    return (
                        typeof dl === 'string' &&
                        dl !== '' &&
                        dl !== 'removed' &&
                        isCdnUrl(dl) &&
                        row.fileId != null
                    );
                });

                const remaining = maxTotal - done;
                const slice = cdnLinked.slice(0, remaining);
                stats.total += slice.length;

                if (slice.length === 0) {
                    if (rows.length < FETCH) break;
                    continue;
                }

                const concurrency = Math.max(1, options.concurrency);
                logger.info(
                    `Batch: levels ${slice[0]!.id}–${slice[slice.length - 1]!.id} (${slice.length} CDN-linked, concurrency=${concurrency})`
                );

                await mapWithConcurrency(slice, concurrency, async (row, idx) => {
                    const position = done + idx + 1;
                    await processLevel(row.id, options, stats, position, totalLabel);
                });

                done += slice.length;

                if (rows.length < FETCH) break;
            }

            if (stats.total === 0) {
                logger.info('No CDN-linked levels in range to process');
            }
        }

        logger.info('\n' + '='.repeat(60));
        logger.info('Run complete');
        logger.info('='.repeat(60));
        logger.info(`CDN-linked seen: ${stats.total}`);
        logger.info(`Processed:        ${stats.processed}`);
        logger.info(`Successful:       ${stats.successful}`);
        logger.info(`Failed:           ${stats.failed}`);
        logger.info(`Skipped / dry:    ${stats.skipped}`);
        logger.info('='.repeat(60));

        if (stats.errors.length > 0) {
            const show = stats.errors.slice(0, 50);
            logger.info('\nErrors (up to 50):');
            show.forEach((e, i) => {
                logger.info(`  ${i + 1}. level ${e.levelId}${e.fileId ? ` file ${e.fileId}` : ''}: ${e.error}`);
            });
            if (stats.errors.length > 50) {
                logger.info(`  …and ${stats.errors.length - 50} more`);
            }
        }

        if (options.dryRun) {
            logger.info('\n[DRY RUN] No cache clears, no DB/ES/cache writes');
        }
    } catch (error) {
        ok = false;
        logger.error('Script failed:', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
        });
    } finally {
        await levelsSequelize.close();
        await cdnSequelize.close();
        logger.info('Database connections closed');
    }
    return ok;
}

const program = new Command();

program
    .name('force-refresh-level-cache')
    .description(
        'By level list: resolve zip UUID from dlLink, refresh CDN cache when stale/missing, then sync chart stats + ES + HTTP cache'
    )
    .option('-d, --dry-run', 'Log actions only', false)
    .option('--level-id <id>', 'Process a single level', (v) => parseInt(v, 10))
    .option(
        '--after-id <id>',
        'Only levels with id greater than this (resume cursor / starting offset)',
        (v) => parseInt(v, 10),
        0
    )
    .option('--offset <id>', 'Alias for --after-id', (v) => parseInt(v, 10))
    .option('-l, --limit <number>', 'Max CDN-linked levels to process', (v) => parseInt(v, 10))
    .option('--concurrency <number>', 'Parallel levels', (v) => parseInt(v, 10), 4)
    .option('--batch-size <number>', 'Levels to fetch per DB page before fan-out', (v) => parseInt(v, 10), 100)
    .option(
        '--force-cache',
        'Always clear and rebuild LEVELZIP cacheData before chart sync (ignore version)',
        false
    )
    .action(async (opts) => {
        const afterId =
            opts.offset !== undefined && Number.isFinite(Number(opts.offset))
                ? Number(opts.offset)
                : Number.isFinite(Number(opts.afterId))
                  ? Number(opts.afterId)
                  : 0;
        const ok = await main({
            dryRun: opts.dryRun,
            limit: Number.isFinite(opts.limit) ? opts.limit : undefined,
            afterId,
            concurrency: Number.isFinite(opts.concurrency) && opts.concurrency > 0 ? opts.concurrency : 4,
            batchSize: Number.isFinite(opts.batchSize) && opts.batchSize > 0 ? opts.batchSize : 100,
            levelId: Number.isFinite(opts.levelId) ? opts.levelId : undefined,
            forceCacheRebuild: opts.forceCache === true
        });
        process.exit(ok ? 0 : 1);
    });

program.parse(process.argv);
