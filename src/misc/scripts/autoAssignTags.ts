import { Command } from 'commander';
import Level from '../../models/levels/Level.js';
import { logger } from '../../server/services/LoggerService.js';
import dotenv from 'dotenv';
import elasticsearchService from '../../server/services/ElasticsearchService.js';
import { initializeAssociations } from '../../models/associations.js';
import { tagAssignmentService } from '../../server/services/TagAssignmentService.js';
dotenv.config();

// Initialize model associations before using them
initializeAssociations();

const elasticsearch = elasticsearchService.getInstance();

/**
 * Auto-assign tags to a level and reindex in Elasticsearch
 */
async function autoAssignTagsAndReindex(levelId: string): Promise<void> {
    await tagAssignmentService.removeAutoTags(parseInt(levelId));
    const result = await tagAssignmentService.assignAutoTags(parseInt(levelId));
    
    if (result.errors.length > 0) {
        for (const error of result.errors) {
            logger.error(`Level ${levelId}: ${error}`);
        }
        return;
    }
    
    if (result.assignedTags.length > 0) {
        await elasticsearch.reindexLevels([parseInt(levelId)]);
    }
}

/**
 * Refresh auto tags for a level (remove and re-assign) and reindex
 */
async function refreshTagsAndReindex(levelId: string): Promise<void> {
    const result = await tagAssignmentService.refreshAutoTags(parseInt(levelId));
    
    if (result.errors.length > 0) {
        for (const error of result.errors) {
            logger.error(`Level ${levelId}: ${error}`);
        }
    }
    
    if (result.removedTags.length > 0 || result.assignedTags.length > 0) {
        await elasticsearch.reindexLevels([parseInt(levelId)]);
    }
}

const program = new Command();

program.command('testAssign')
  .description('Auto assign tags to a single level based on analysis data')
  .option('-l, --levelId <levelId>', 'Level ID to assign tags to', '1')
  .action(async (options) => {
    try {
      await autoAssignTagsAndReindex(options.levelId);
    } catch (error) {
      logger.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
    process.exit(0);
  });

program.command('testRefresh')
  .description('Refresh (remove and re-assign) auto tags for a single level')
  .option('-l, --levelId <levelId>', 'Level ID to refresh tags for', '1')
  .action(async (options) => {
    try {
      await refreshTagsAndReindex(options.levelId);
    } catch (error) {
      logger.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
    process.exit(0);
  });

program.command('autoAssignTags')
  .description('Auto assign tags to levels based on analysis data (batch)')
  .option('-o, --offset <offset>', 'Offset to start from', '0')
  .option('-l, --limit <limit>', 'Limit to process', '100')
  .option('-b, --batch-size <batchSize>', 'Batch size to process', '50')
  .action(async (options) => {
    try {
        const offset = parseInt(options.offset) || 0;
        const limit = parseInt(options.limit) || 100;
        const batchSize = parseInt(options.batchSize) || 50;
        const totalBatches = Math.ceil(limit / batchSize);
        let batchNumber = 0;

        for (let i = offset; i < offset + limit; i += batchSize) {
            batchNumber++;
            const levelIds = await Level.findAll({
                attributes: ['id'],
                offset: i,
                limit: Math.min(batchSize, offset + limit - i)
            });
            const promises = levelIds.map(level => autoAssignTagsAndReindex(level.id.toString()).catch(error => {
                if (!error.message?.includes("Cannot destructure property")) {
                    logger.error(`Error assigning tags to level ${level.id}:`, error instanceof Error ? error.message : error);
                }
                return null;
            }));
            await Promise.all(promises);
            logger.info(`Processed batch ${batchNumber} of ${totalBatches}`);
        }
    } catch (error) {
      logger.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    } finally {
      process.exit(0);
    }
  });

program.command('refreshAllTags')
  .description('Refresh (remove and re-assign) auto tags for levels (batch)')
  .option('-o, --offset <offset>', 'Offset to start from', '0')
  .option('-l, --limit <limit>', 'Limit to process', '100')
  .option('-b, --batch-size <batchSize>', 'Batch size to process', '50')
  .action(async (options) => {
    try {
        const offset = parseInt(options.offset) || 0;
        const limit = parseInt(options.limit) || 100;
        const batchSize = parseInt(options.batchSize) || 50;
        const totalBatches = Math.ceil(limit / batchSize);
        let batchNumber = 0;

        for (let i = offset; i < offset + limit; i += batchSize) {
            batchNumber++;
            const levelIds = await Level.findAll({
                attributes: ['id'],
                offset: i,
                limit: Math.min(batchSize, offset + limit - i)
            });
            const promises = levelIds.map(level => refreshTagsAndReindex(level.id.toString()).catch(error => {
                logger.error(`Error refreshing tags for level ${level.id}:`, error instanceof Error ? error.message : error);
                return null;
            }));
            await Promise.all(promises);
            logger.info(`Processed batch ${batchNumber} of ${totalBatches}`);
        }
    } catch (error) {
      logger.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    } finally {
      process.exit(0);
    }
  });

program.parse(process.argv);
