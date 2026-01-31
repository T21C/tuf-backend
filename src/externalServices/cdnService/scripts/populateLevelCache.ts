#!/usr/bin/env ts-node

import { Command } from 'commander';
import { logger } from '../../../server/services/LoggerService.js';
import CdnFile from '../../../models/cdn/CdnFile.js';
import { getSequelizeForModelGroup } from '../../../config/db.js';

const sequelize = getSequelizeForModelGroup('cdn');
import { levelCacheService } from '../services/levelCacheService.js';

/**
 * Script to populate cache for all LEVELZIP files with null cacheData
 * This ensures all level files have cached tilecount and settings data
 */

interface ScriptStats {
    total: number;
    processed: number;
    successful: number;
    failed: number;
    skipped: number;
    errors: Array<{ fileId: string; error: string }>;
}

/**
 * Process a single file to populate its cache
 */
async function populateCacheForFile(file: CdnFile, stats: ScriptStats): Promise<void> {
    try {
        logger.info(`[${stats.processed + 1}/${stats.total}] Processing file: ${file.id}`);

        // Try to populate cache
        const cacheData = await levelCacheService.ensureCachePopulated(file.id);

        if (cacheData) {
            stats.successful++;
            logger.info(`✓ Successfully populated cache for file: ${file.id}`, {
                tilecount: cacheData.tilecount,
                hasSettings: !!cacheData.settings
            });
        } else {
            stats.failed++;
            const error = 'Failed to populate cache (returned null)';
            stats.errors.push({ fileId: file.id, error });
            logger.warn(`✗ Failed to populate cache for file: ${file.id}`);
        }
    } catch (error) {
        stats.failed++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        stats.errors.push({ fileId: file.id, error: errorMessage });
        logger.error(`✗ Error populating cache for file: ${file.id}`, {
            error: errorMessage
        });
    }

    stats.processed++;
}

/**
 * Find all LEVELZIP files with null cacheData
 */
async function findFilesNeedingCache(onlyNull: boolean): Promise<CdnFile[]> {
    const where: any = {
        type: 'LEVELZIP'
    };

    if (onlyNull) {
        where.cacheData = null;
    }

    const files = await CdnFile.findAll({
        where,
        order: [['createdAt', 'ASC']]
    });

    return files;
}

/**
 * Main script execution
 */
async function main(options: {
    dryRun: boolean;
    limit?: number;
    onlyNull: boolean;
    fileId?: string;
}) {
    logger.info('Starting level cache population script', options);

    try {
        // Connect to database
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

        // If specific fileId provided, process only that file
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
                logger.info('[DRY RUN] Would populate cache for file:', {
                    fileId: file.id,
                    currentCache: file.cacheData ? 'exists' : 'null'
                });
                stats.skipped = 1;
            } else {
                await populateCacheForFile(file, stats);
            }
        } else {
            // Find all files needing cache population
            logger.info(`Finding LEVELZIP files ${options.onlyNull ? 'with null cacheData' : '(all files)'}...`);
            const files = await findFilesNeedingCache(options.onlyNull);

            stats.total = options.limit ? Math.min(files.length, options.limit) : files.length;

            logger.info(`Found ${files.length} LEVELZIP files, processing ${stats.total}`);

            if (files.length === 0) {
                logger.info('No files found to process');
                return;
            }

            // Process files
            const filesToProcess = options.limit ? files.slice(0, options.limit) : files;

            if (options.dryRun) {
                logger.info('[DRY RUN] Would process the following files:');
                filesToProcess.forEach((file, index) => {
                    logger.info(`  [${index + 1}/${stats.total}] ${file.id} - Cache: ${file.cacheData ? 'exists' : 'null'}`);
                });
                stats.skipped = stats.total;
            } else {
                // Process files sequentially to avoid overwhelming the system
                for (const file of filesToProcess) {
                    await populateCacheForFile(file, stats);

                    // Log progress every 10 files
                    if (stats.processed % 10 === 0) {
                        logger.info(`Progress: ${stats.processed}/${stats.total} processed (${stats.successful} successful, ${stats.failed} failed)`);
                    }
                }
            }
        }

        // Print final statistics
        logger.info('\n' + '='.repeat(60));
        logger.info('Cache Population Complete');
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

// Setup CLI
const program = new Command();

program
    .name('populate-level-cache')
    .description('Populate cache for LEVELZIP files with null cacheData')
    .option('-d, --dry-run', 'Run in dry-run mode without making changes', false)
    .option('-l, --limit <number>', 'Limit the number of files to process', (value) => parseInt(value, 10))
    .option('-a, --all', 'Process all LEVELZIP files, not just those with null cache', false)
    .option('-f, --file-id <fileId>', 'Process a specific file by ID')
    .action(async (options) => {
        await main({
            dryRun: options.dryRun,
            limit: options.limit,
            onlyNull: !options.all,
            fileId: options.fileId
        });
    });

program.parse(process.argv);

