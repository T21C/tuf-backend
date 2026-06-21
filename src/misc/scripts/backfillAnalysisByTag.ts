#!/usr/bin/env ts-node

/**
 * Rebuild CDN analysis cache and sync chart stats (including autoTileCount) for levels
 * that have a given tag assignment.
 *
 * Example: refresh all levels tagged "Auto Tile" so autoTileCount matches parsed analysis.
 *
 * Usage (from server/):
 *   npx tsx src/misc/scripts/backfillAnalysisByTag.ts --tag-name "Auto Tile" --dry-run
 *   npx tsx src/misc/scripts/backfillAnalysisByTag.ts --tag-name "Auto Tile" --limit 100
 *   npx tsx src/misc/scripts/backfillAnalysisByTag.ts --tag-name "Auto Tile" --level-id 9611
 *   npx tsx src/misc/scripts/backfillAnalysisByTag.ts --tag-name "Auto Tile" --after-id 0 --concurrency 4
 */

import { Command } from 'commander';
import dotenv from 'dotenv';
import { Op } from 'sequelize';

dotenv.config();

import { logger } from '@/server/services/core/LoggerService.js';
import Level from '@/models/levels/Level.js';
import LevelTag from '@/models/levels/LevelTag.js';
import LevelTagAssignment from '@/models/levels/LevelTagAssignment.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
import { isCdnUrl } from '@/misc/utils/Utility.js';
import { applyLevelChartStatsFromCdn } from '@/misc/utils/data/levelChartStatsSync.js';
import { initializeAssociations } from '@/models/associations.js';
import { tagAssignmentService } from '@/server/services/data/TagAssignmentService.js';
import elasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {
    levelCacheService,
    SAFE_TO_PARSE_VERSION,
} from '@/externalServices/cdnService/services/levelCacheService.js';

initializeAssociations();

const levelsSequelize = getSequelizeForModelGroup('levels');
const cdnSequelize = getSequelizeForModelGroup('cdn');
const elasticsearch = elasticsearchService.getInstance();

interface ScriptStats {
    total: number;
    processed: number;
    successful: number;
    failed: number;
    skipped: number;
    tagsRefreshed: number;
    errors: Array<{ levelId: number; fileId?: string; error: string }>;
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

async function resolveTagId(tagName: string): Promise<number> {
    const tag = await LevelTag.findOne({ where: { name: tagName }, attributes: ['id', 'name'] });
    if (!tag) {
        throw new Error(`Tag not found: "${tagName}"`);
    }
    return tag.id;
}

async function fetchLevelIdsByTag(
    tagId: number,
    options: { afterId: number; limit: number }
): Promise<number[]> {
    const rows = await LevelTagAssignment.findAll({
        attributes: ['levelId'],
        where: {
            tagId,
            ...(options.afterId > 0 ? { levelId: { [Op.gt]: options.afterId } } : {}),
        },
        order: [['levelId', 'ASC']],
        limit: options.limit,
    });
    return rows.map((row) => row.levelId);
}

async function processLevel(
    levelId: number,
    options: { dryRun: boolean; forceCacheRebuild: boolean; refreshTags: boolean },
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
            error: !file ? 'orphan dlLink (no CDN row)' : `not a LEVELZIP (type=${file.type})`,
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

    if (options.dryRun) {
        logger.info(
            `[DRY RUN] ${label} level=${levelId} file=${fileId} forceCacheRebuild=${options.forceCacheRebuild} refreshTags=${options.refreshTags}`
        );
        stats.skipped++;
        stats.processed++;
        return;
    }

    try {
        if (options.forceCacheRebuild) {
            logger.info(`${label} Rebuilding CDN cache for level ${levelId} (file ${fileId})`);
            await levelCacheService.clearCache(file);
            const cacheData = await levelCacheService.refreshCache(file.id);
            if (!cacheData) {
                stats.failed++;
                stats.errors.push({ levelId, fileId, error: 'refreshCache returned null' });
                logger.error(`${label} Level ${levelId}: cache repopulate failed (${fileId})`);
                stats.processed++;
                return;
            }
        }

        await applyLevelChartStatsFromCdn(levelId);

        if (options.refreshTags) {
            const tagResult = await tagAssignmentService.refreshAutoTags(levelId);
            if (tagResult.errors.length > 0) {
                for (const error of tagResult.errors) {
                    logger.warn(`${label} Level ${levelId} tag refresh: ${error}`);
                }
            }
            if (tagResult.removedTags.length > 0 || tagResult.assignedTags.length > 0) {
                await elasticsearch.reindexLevels([levelId]);
                stats.tagsRefreshed++;
                logger.info(
                    `${label} Level ${levelId}: tags updated (+${tagResult.assignedTags.join(', ') || 'none'} -${tagResult.removedTags.join(', ') || 'none'})`
                );
            }
        }

        stats.successful++;
        logger.info(`${label} Level ${levelId}: analysis + chart stats OK`);
    } catch (error) {
        stats.failed++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        stats.errors.push({ levelId, fileId, error: errorMessage });
        logger.error(`${label} Level ${levelId}:`, { fileId, error: errorMessage });
    }

    stats.processed++;
}

async function main(options: {
    tagName: string;
    dryRun: boolean;
    limit?: number;
    afterId: number;
    concurrency: number;
    batchSize: number;
    levelId?: number;
    forceCacheRebuild: boolean;
    refreshTags: boolean;
}): Promise<boolean> {
    logger.info('Backfill analysis by tag', {
        ...options,
        safeToParseVersion: SAFE_TO_PARSE_VERSION,
    });

    let ok = true;
    try {
        await levelsSequelize.authenticate();
        await cdnSequelize.authenticate();
        logger.info('Database connections established (levels + cdn)');

        const tagId = await resolveTagId(options.tagName);
        logger.info(`Resolved tag "${options.tagName}" (id=${tagId})`);

        const stats: ScriptStats = {
            total: 0,
            processed: 0,
            successful: 0,
            failed: 0,
            skipped: 0,
            tagsRefreshed: 0,
            errors: [],
        };

        if (options.levelId !== undefined) {
            stats.total = 1;
            await processLevel(options.levelId, options, stats, 1, '1');
        } else {
            const maxTotal = options.limit ?? Number.MAX_SAFE_INTEGER;
            let done = 0;
            let afterId = options.afterId;
            const totalLabel = options.limit !== undefined ? String(options.limit) : '—';

            while (done < maxTotal) {
                const fetchLimit = Math.min(
                    Math.max(500, options.batchSize),
                    maxTotal - done
                );
                const levelIds = await fetchLevelIdsByTag(tagId, {
                    afterId,
                    limit: fetchLimit,
                });

                if (levelIds.length === 0) break;

                afterId = levelIds[levelIds.length - 1]!;
                stats.total += levelIds.length;

                const concurrency = Math.max(1, options.concurrency);
                logger.info(
                    `Batch: levels ${levelIds[0]!}–${levelIds[levelIds.length - 1]!} (${levelIds.length} tagged, concurrency=${concurrency})`
                );

                await mapWithConcurrency(levelIds, concurrency, async (levelId, idx) => {
                    const position = done + idx + 1;
                    await processLevel(levelId, options, stats, position, totalLabel);
                });

                done += levelIds.length;

                if (levelIds.length < fetchLimit) break;
            }

            if (stats.total === 0) {
                logger.info(`No levels found with tag "${options.tagName}"`);
            }
        }

        logger.info('\n' + '='.repeat(60));
        logger.info('Run complete');
        logger.info('='.repeat(60));
        logger.info(`Tagged levels seen: ${stats.total}`);
        logger.info(`Processed:          ${stats.processed}`);
        logger.info(`Successful:         ${stats.successful}`);
        logger.info(`Failed:             ${stats.failed}`);
        logger.info(`Skipped / dry:      ${stats.skipped}`);
        logger.info(`Tags refreshed:     ${stats.tagsRefreshed}`);
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
            stack: error instanceof Error ? error.stack : undefined,
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
    .name('backfill-analysis-by-tag')
    .description(
        'Rebuild CDN analysis cache and sync chart stats for levels that have a given tag (e.g. "Auto Tile")'
    )
    .requiredOption('-t, --tag-name <name>', 'Only process levels with this tag assignment')
    .option('-d, --dry-run', 'Log actions only', false)
    .option('--level-id <id>', 'Process a single level (ignores tag filter)', (v) => parseInt(v, 10))
    .option(
        '--after-id <id>',
        'Only tagged levels with id greater than this (resume cursor)',
        (v) => parseInt(v, 10),
        0
    )
    .option('--offset <id>', 'Alias for --after-id', (v) => parseInt(v, 10))
    .option('-l, --limit <number>', 'Max tagged levels to process', (v) => parseInt(v, 10))
    .option('--concurrency <number>', 'Parallel levels', (v) => parseInt(v, 10), 4)
    .option('--batch-size <number>', 'Tagged levels to fetch per DB page', (v) => parseInt(v, 10), 100)
    .option(
        '--no-force-cache',
        'Skip CDN cache rebuild; only sync chart stats from existing cache'
    )
    .option(
        '--no-refresh-tags',
        'Skip auto-tag refresh after analysis rebuild'
    )
    .action(async (opts) => {
        const afterId =
            opts.offset !== undefined && Number.isFinite(Number(opts.offset))
                ? Number(opts.offset)
                : Number.isFinite(Number(opts.afterId))
                  ? Number(opts.afterId)
                  : 0;
        const ok = await main({
            tagName: opts.tagName,
            dryRun: opts.dryRun,
            limit: Number.isFinite(opts.limit) ? opts.limit : undefined,
            afterId,
            concurrency: Number.isFinite(opts.concurrency) && opts.concurrency > 0 ? opts.concurrency : 4,
            batchSize: Number.isFinite(opts.batchSize) && opts.batchSize > 0 ? opts.batchSize : 100,
            levelId: Number.isFinite(opts.levelId) ? opts.levelId : undefined,
            forceCacheRebuild: opts.forceCache !== false,
            refreshTags: opts.refreshTags !== false,
        });
        process.exit(ok ? 0 : 1);
    });

program.parse(process.argv);
