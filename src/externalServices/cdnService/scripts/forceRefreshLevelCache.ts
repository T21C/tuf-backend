#!/usr/bin/env ts-node

import { Command } from 'commander';
import { Op } from 'sequelize';
import { logger } from '@/server/services/core/LoggerService.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('cdn');
import { levelCacheService } from '../services/levelCacheService.js';

/**
 * Force-refresh LEVELZIP cacheData (tilecount, settings, analysis, transformOptions) by
 * clearing persisted cache and re-parsing the target level with the current adofai-lib.
 *
 * Use after parsing / LevelDict / analysis logic changes when bumping SAFE_TO_PARSE_VERSION
 * or ANALYSIS_FORMAT_VERSION alone is not enough, or you want a one-off full rebuild.
 */

interface ScriptStats {
    total: number;
    processed: number;
    successful: number;
    failed: number;
    skipped: number;
    errors: Array<{ fileId: string; error: string }>;
}

async function refreshCacheForFile(file: CdnFile, stats: ScriptStats): Promise<void> {
    try {
        logger.info(`[${stats.processed + 1}/${stats.total}] Force-refresh: ${file.id}`);

        const metadata = file.metadata as { targetLevelOversized?: boolean } | undefined;
        if (metadata?.targetLevelOversized) {
            stats.skipped++;
            logger.warn(`Oversized level (cache not available): ${file.id}`);
            stats.processed++;
            return;
        }

        await levelCacheService.clearCache(file);
        const cacheData = await levelCacheService.ensureCachePopulated(file.id);

        if (cacheData) {
            stats.successful++;
            logger.info(`Refreshed cache for file: ${file.id}`, {
                tilecount: cacheData.tilecount,
                hasSettings: !!cacheData.settings
            });
        } else {
            stats.failed++;
            const error = 'Failed to repopulate cache after clear (returned null)';
            stats.errors.push({ fileId: file.id, error });
            logger.warn(`Failed to refresh cache for file: ${file.id}`);
        }
    } catch (error) {
        stats.failed++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        stats.errors.push({ fileId: file.id, error: errorMessage });
        logger.error(`Error refreshing cache for file: ${file.id}`, {
            error: errorMessage
        });
    }

    stats.processed++;
}

async function findLevelZipFiles(options: { onlyWithExistingCache: boolean }): Promise<CdnFile[]> {
    const where: Record<string, unknown> = {
        type: 'LEVELZIP'
    };

    if (options.onlyWithExistingCache) {
        where.cacheData = { [Op.ne]: null };
    }

    return CdnFile.findAll({
        where,
        order: [['createdAt', 'ASC']]
    });
}

async function main(options: {
    dryRun: boolean;
    limit?: number;
    onlyWithExistingCache: boolean;
    fileId?: string;
}) {
    logger.info('Starting force refresh of LEVELZIP cache metadata', options);

    try {
        await sequelize.authenticate();
        logger.info('Database connection established');

        const stats: ScriptStats = {
            total: 0,
            processed: 0,
            successful: 0,
            failed: 0,
            skipped: 0,
            errors: []
        };

        if (options.fileId) {
            logger.info(`Processing specific file: ${options.fileId}`);
            const file = await CdnFile.findByPk(options.fileId);

            if (!file) {
                logger.error(`File not found: ${options.fileId}`);
                process.exit(1);
            }

            if (file.type !== 'LEVELZIP') {
                logger.error(`File is not a LEVELZIP: ${options.fileId} (type: ${file.type})`);
                process.exit(1);
            }

            stats.total = 1;

            if (options.dryRun) {
                logger.info('[DRY RUN] Would clear cache and repopulate for file:', {
                    fileId: file.id,
                    hadCache: !!file.cacheData
                });
                stats.skipped = 1;
            } else {
                await refreshCacheForFile(file, stats);
            }
        } else {
            const files = await findLevelZipFiles({
                onlyWithExistingCache: options.onlyWithExistingCache
            });

            stats.total = options.limit ? Math.min(files.length, options.limit) : files.length;

            logger.info(
                `Found ${files.length} LEVELZIP files${options.onlyWithExistingCache ? ' (with existing cache) ' : ' '}` +
                    `— processing ${stats.total}`
            );

            if (files.length === 0) {
                logger.info('No files found to process');
                return;
            }

            const filesToProcess = options.limit ? files.slice(0, options.limit) : files;

            if (options.dryRun) {
                logger.info('[DRY RUN] Would clear and repopulate cache for:');
                filesToProcess.forEach((file, index) => {
                    logger.info(`  [${index + 1}/${stats.total}] ${file.id} — cache: ${file.cacheData ? 'yes' : 'no'}`);
                });
                stats.skipped = stats.total;
            } else {
                for (const file of filesToProcess) {
                    await refreshCacheForFile(file, stats);

                    if (stats.processed % 10 === 0) {
                        logger.info(
                            `Progress: ${stats.processed}/${stats.total} processed (${stats.successful} successful, ${stats.failed} failed)`
                        );
                    }
                }
            }
        }

        logger.info('\n' + '='.repeat(60));
        logger.info('Force refresh complete');
        logger.info('='.repeat(60));
        logger.info(`Total files:      ${stats.total}`);
        logger.info(`Processed:        ${stats.processed}`);
        logger.info(`Successful:       ${stats.successful}`);
        logger.info(`Failed:           ${stats.failed}`);
        logger.info(`Skipped:          ${stats.skipped}`);
        logger.info('='.repeat(60));

        if (stats.errors.length > 0) {
            logger.info('\nErrors encountered:');
            stats.errors.forEach((error, index) => {
                logger.info(`  ${index + 1}. File ${error.fileId}: ${error.error}`);
            });
        }

        if (options.dryRun) {
            logger.info('\n[DRY RUN] No changes were made to the database');
        }
    } catch (error) {
        logger.error('Script failed with error:', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
        });
        process.exit(1);
    } finally {
        await sequelize.close();
        logger.info('Database connection closed');
    }
}

const program = new Command();

program
    .name('force-refresh-level-cache')
    .description('Clear and rebuild LEVELZIP cacheData (re-parse with current adofai-lib)')
    .option('-d, --dry-run', 'Run without clearing or writing cache', false)
    .option('-l, --limit <number>', 'Max number of files to process', (value) => parseInt(value, 10))
    .option(
        '-c, --only-cached',
        'Only process LEVELZIP rows that already have cacheData (skip never-cached rows)',
        false
    )
    .option('-f, --file-id <fileId>', 'Process a single file by ID')
    .action(async (options) => {
        await main({
            dryRun: options.dryRun,
            limit: options.limit,
            onlyWithExistingCache: options.onlyCached,
            fileId: options.fileId
        });
    });

program.parse(process.argv);
