/**
 * Backfill `levels.downloadCount` from the currently linked CDN file's `accessCount`.
 *
 * This is a one-off bridge to preserve historical counts before the new ingest pipeline
 * becomes the source of truth.
 *
 * Usage (from server/):
 *   npx tsx src/misc/scripts/backfillLevelDownloadCountFromCdn.ts --dry-run
 *   npx tsx src/misc/scripts/backfillLevelDownloadCountFromCdn.ts --level-id 12345
 *   npx tsx src/misc/scripts/backfillLevelDownloadCountFromCdn.ts --limit 500 --concurrency 6
 */

import { Command } from 'commander';
import dotenv from 'dotenv';
import { Op } from 'sequelize';

dotenv.config();

import Level from '@/models/levels/Level.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { isCdnUrl } from '@/misc/utils/Utility.js';
import cdnService from '@/server/services/core/CdnService.js';
import { initializeAssociations } from '@/models/associations.js';
import CdnFile from '@/models/cdn/CdnFile.js';

initializeAssociations();

const levelsSequelize = getSequelizeForModelGroup('levels');

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

async function backfillOneLevel(levelId: number, dryRun: boolean): Promise<boolean> {
  const level = await Level.findByPk(levelId, { attributes: ['id', 'dlLink', 'downloadCount', 'fileId'] });
  if (!level) {
    return false;
  }

  if (typeof level.downloadCount === 'number' && level.downloadCount > 0) {
    return false;
  }

  const fileId = level.fileId ?? null;
  if (!fileId) {
    return false;
  }

  const file = await CdnFile.findByPk(fileId, { attributes: ['accessCount'] });
  if (!file) {
    return false;
  }

  const accessCount = file.accessCount;
  if (dryRun) {
    logger.info(`[DRY RUN] Would set level ${levelId} downloadCount=${accessCount}`);
    return true;
  }

  await Level.update(
    { downloadCount: accessCount },
    {
      where: {
        id: levelId,
        downloadCount: 0,
      },
    }
  );
  return true;
}

async function run(options: RunOptions): Promise<void> {
  await levelsSequelize.authenticate();
  logger.info('Database connection OK', { dryRun: options.dryRun });

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  if (options.levelId !== undefined) {
    try {
      const did = await backfillOneLevel(options.levelId, options.dryRun);
      if (did) updated++;
      else skipped++;
    } catch (e) {
      failed++;
      logger.error(`Failed level ${options.levelId}`, {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    logger.info('Done (single level)', { updated, skipped, failed });
    return;
  }

  const maxTotal = options.limit ?? Number.MAX_SAFE_INTEGER;
  let processed = 0;
  let afterId = options.afterId;
  const FETCH = 500;

  while (processed < maxTotal) {
    const batch = await Level.findAll({
      where: { id: { [Op.gt]: afterId } },
      attributes: ['id', 'dlLink', 'downloadCount'],
      order: [['id', 'ASC']],
      limit: FETCH,
    });

    if (batch.length === 0) break;
    afterId = batch[batch.length - 1].id;

    const candidates = batch.filter(
      (l) =>
        (l.downloadCount ?? 0) === 0 &&
        typeof l.dlLink === 'string' &&
        l.dlLink !== '' &&
        l.dlLink !== 'removed' &&
        isCdnUrl(l.dlLink)
    );

    const remaining = maxTotal - processed;
    const slice = candidates.slice(0, remaining);

    await mapWithConcurrency(slice, options.concurrency, async (level) => {
      try {
        const did = await backfillOneLevel(level.id, options.dryRun);
        if (did) {
          updated++;
        } else {
          skipped++;
        }
      } catch (e) {
        failed++;
        logger.error(`Failed level ${level.id}`, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    });

    processed += slice.length;
    if (batch.length < FETCH) break;
  }

  logger.info('Done', { updated, skipped, failed, dryRun: options.dryRun });
}

const program = new Command();

program
  .name('backfill-level-download-count-from-cdn')
  .description('Copy CDN accessCount into levels.downloadCount for currently-linked CDN levels')
  .option('-d, --dry-run', 'Do not write to DB', false)
  .option('--level-id <id>', 'Single level id', (v) => parseInt(v, 10))
  .option('-l, --limit <n>', 'Max number of levels to consider', (v) => parseInt(v, 10))
  .option('--after-id <id>', 'Only consider levels with id greater than this (cursor)', (v) => parseInt(v, 10), 0)
  .option('--concurrency <n>', 'Parallel CDN fetches', (v) => parseInt(v, 10), 4)
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
      process.exit(0);
    }
  });

program.parse(process.argv);

