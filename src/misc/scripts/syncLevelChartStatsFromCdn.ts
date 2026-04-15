/**
 * Rebuild `cdn_files.cacheData` for each level's zip (like a fresh parse), then sync
 * `levels.bpm`, `tilecount`, and `levelLengthInMs` from cache (`refresh` + DB + ES).
 *
 * Use after parsing changes, target-level fixes, or when denormalized stats drift.
 *
 * Usage (from server/):
 *   npx tsx src/misc/scripts/syncLevelChartStatsFromCdn.ts --dry-run
 *   npx tsx src/misc/scripts/syncLevelChartStatsFromCdn.ts --level-id 12345
 *   npx tsx src/misc/scripts/syncLevelChartStatsFromCdn.ts --limit 500 --concurrency 8
 *   npx tsx src/misc/scripts/syncLevelChartStatsFromCdn.ts --after-id 1000000 --limit 100
 */

import { Command } from 'commander';
import dotenv from 'dotenv';
import { Op } from 'sequelize';

dotenv.config();

import Level from '@/models/levels/Level.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { getFileIdFromCdnUrl, isCdnUrl } from '@/misc/utils/Utility.js';
import { applyLevelChartStatsFromCdn } from '@/misc/utils/data/levelChartStatsSync.js';
import cdnService from '@/server/services/core/CdnService.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { initializeAssociations } from '@/models/associations.js';

initializeAssociations()

const elasticsearchService = ElasticsearchService.getInstance();

const levelsSequelize = getSequelizeForModelGroup('levels');
const cdnSequelize = getSequelizeForModelGroup('cdn');

/** CDN refresh + DB/ES sync; falls back to `applyLevelChartStatsFromCdn` if refresh fails. */
async function rebuildCdnCacheAndApplyLevelChartStats(levelId: number): Promise<void> {
  const level = await Level.findByPk(levelId, { attributes: ['id', 'dlLink'] });
  if (!level) {
    return;
  }

  if (!level.dlLink || !isCdnUrl(level.dlLink)) {
    await applyLevelChartStatsFromCdn(levelId);
    return;
  }

  const fileId = getFileIdFromCdnUrl(level.dlLink);
  if (!fileId) {
    await applyLevelChartStatsFromCdn(levelId);
    return;
  }

  try {
    const { bpm, tilecount, levelLengthInMs } = await cdnService.refreshLevelChartCacheAndGetStats(fileId);
    await Level.update({ bpm, tilecount, levelLengthInMs }, { where: { id: levelId }, hooks: false });
    await elasticsearchService.indexLevel(levelId);
  } catch {
    await applyLevelChartStatsFromCdn(levelId);
  }
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const n = Math.min(Math.max(1, concurrency), items.length);
  let index = 0;
  const worker = async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: n }, () => worker()));
}

interface RunOptions {
  dryRun: boolean;
  levelId?: number;
  limit?: number;
  afterId: number;
  concurrency: number;
}

async function run(options: RunOptions): Promise<void> {
  await levelsSequelize.authenticate();
  await cdnSequelize.authenticate();
  logger.info('Database connections OK', { dryRun: options.dryRun });

  let successful = 0;
  let failed = 0;
  const errors: Array<{ levelId: number; message: string }> = [];

  if (options.levelId !== undefined) {
    if (options.dryRun) {
      logger.info(`[DRY RUN] Would rebuild CDN cache and sync chart stats for level ${options.levelId}`);
      return;
    }
    try {
      await rebuildCdnCacheAndApplyLevelChartStats(options.levelId);
      successful++;
      logger.info(`Synced level ${options.levelId}`);
    } catch (e) {
      failed++;
      const message = e instanceof Error ? e.message : String(e);
      errors.push({ levelId: options.levelId, message });
      logger.error(`Failed level ${options.levelId}: ${message}`);
    }
    logger.info('Done (single level)', { successful, failed });
    return;
  }

  const maxTotal = options.limit ?? Number.MAX_SAFE_INTEGER;
  let synced = 0;
  let afterId = options.afterId;
  const FETCH = 500;

  while (synced < maxTotal) {
    const batch = await Level.findAll({
      where: { id: { [Op.gt]: afterId } },
      attributes: ['id', 'dlLink'],
      order: [['id', 'ASC']],
      limit: FETCH,
    });

    if (batch.length === 0) break;

    afterId = batch[batch.length - 1].id;

    const cdnLinked = batch.filter(
      (l) => typeof l.dlLink === 'string' && l.dlLink !== '' && l.dlLink !== 'removed' && isCdnUrl(l.dlLink)
    );
    const remaining = maxTotal - synced;
    const slice = cdnLinked.slice(0, remaining);

    if (options.dryRun) {
      for (const l of slice) {
        logger.info(`[DRY RUN] Would sync level ${l.id}`);
      }
      synced += slice.length;
    } else {
      await mapWithConcurrency(slice, options.concurrency, async (level) => {
        try {
          await rebuildCdnCacheAndApplyLevelChartStats(level.id);
          successful++;
          logger.info(`Synced level ${level.id}`);
        } catch (e) {
          failed++;
          const message = e instanceof Error ? e.message : String(e);
          errors.push({ levelId: level.id, message });
          logger.error(`Failed level ${level.id}: ${message}`);
        }
      });
      synced += slice.length;
    }

    if (batch.length < FETCH) break;
  }

  logger.info('Done', {
    successful,
    failed,
    dryRun: options.dryRun,
    processedCdnLevelsApprox: options.dryRun ? synced : successful + failed,
  });
  if (errors.length > 0 && errors.length <= 50) {
    errors.forEach((e) => logger.info(`  level ${e.levelId}: ${e.message}`));
  } else if (errors.length > 50) {
    logger.info(`  (${errors.length} errors; omitting list)`);
  }
}

const program = new Command();

program
  .name('sync-level-chart-stats-from-cdn')
  .description('Rebuild CDN level zip cache and sync bpm/tilecount/levelLengthInMs on level rows')
  .option('-d, --dry-run', 'List levels that would be processed', false)
  .option('--level-id <id>', 'Single level id', (v) => parseInt(v, 10))
  .option('-l, --limit <n>', 'Max number of CDN-linked levels to process', (v) => parseInt(v, 10))
  .option('--after-id <id>', 'Only consider levels with id greater than this (cursor)', (v) => parseInt(v, 10), 0)
  .option('--concurrency <n>', 'Parallel syncs', (v) => parseInt(v, 10), 4)
  .action(async (opts) => {
    try {
      await run({
        dryRun: opts.dryRun,
        levelId: Number.isFinite(opts.levelId) ? opts.levelId : undefined,
        limit: Number.isFinite(opts.limit) ? opts.limit : undefined,
        afterId: Number.isFinite(opts.afterId) ? opts.afterId : 0,
        concurrency: Number.isFinite(opts.concurrency) && opts.concurrency > 0 ? opts.concurrency : 4,
      });
    } finally {
      await levelsSequelize.close();
      await cdnSequelize.close();
    }
  });

program.parse(process.argv);
