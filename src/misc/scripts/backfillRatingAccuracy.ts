#!/usr/bin/env ts-node

/**
 * Upsert rating-accuracy snapshots, samples, and career stats for confirmed ratings.
 * Safe to rerun indefinitely. Each run overwrites frozenRating from live details
 * and settledDiffId/clearsAtSettle from the current level row.
 *
 * Usage (from server/):
 *   npx tsx src/misc/scripts/backfillRatingAccuracy.ts --dry-run
 *   npx tsx src/misc/scripts/backfillRatingAccuracy.ts
 *   npx tsx src/misc/scripts/backfillRatingAccuracy.ts --rating-id 123
 *   npx tsx src/misc/scripts/backfillRatingAccuracy.ts --after-id 0 --limit 500
 */

import {Command} from 'commander';
import dotenv from 'dotenv';
import {Op} from 'sequelize';

dotenv.config();

import {logger} from '@/server/services/core/LoggerService.js';
import {getSequelizeForModelGroup} from '@/config/db.js';
import {initializeAssociations} from '@/models/associations.js';
import Rating from '@/models/levels/Rating.js';
import Level from '@/models/levels/Level.js';
import RatingDetail from '@/models/levels/RatingDetail.js';
import {
  freezeAndUpsertRating,
  invalidateRatingAccuracyCache,
  rebuildAllStats,
} from '@/server/services/ratings/ratingAccuracyService.js';

initializeAssociations();

const levelsSequelize = getSequelizeForModelGroup('levels');

type ScriptStats = {
  total: number;
  processed: number;
  samples: number;
  skippedAutorater: number;
  skippedNoSettle: number;
  failed: number;
  errors: Array<{ratingId: number; error: string}>;
};

async function processRating(
  rating: Rating,
  dryRun: boolean,
  stats: ScriptStats,
): Promise<void> {
  const level = rating.level;
  const settledDiffId = level?.diffId ?? rating.settledDiffId ?? null;
  const clearsAtSettle = level?.clears ?? rating.clearsAtSettle ?? 0;
  const label = `rating ${rating.id} level ${rating.levelId}`;

  if (dryRun) {
    const detailCount = await RatingDetail.count({where: {ratingId: rating.id}});
    logger.info(
      `[DRY RUN] ${label}: settledDiffId=${settledDiffId} clearsAtSettle=${clearsAtSettle} details=${detailCount}`,
    );
    stats.processed += 1;
    return;
  }

  try {
    const result = await freezeAndUpsertRating(rating.id, {
      settledDiffId,
      clearsAtSettle,
    });
    stats.samples += result.samples;
    stats.skippedAutorater += result.skippedAutorater;
    stats.skippedNoSettle += result.skippedNoSettle;
    stats.processed += 1;
    logger.info(
      `${label}: samples=${result.samples} autorater=${result.skippedAutorater} noSettle=${result.skippedNoSettle}`,
    );
  } catch (error) {
    stats.failed += 1;
    stats.processed += 1;
    const message = error instanceof Error ? error.message : String(error);
    stats.errors.push({ratingId: rating.id, error: message});
    logger.error(`${label} failed: ${message}`);
  }
}

async function main(options: {
  dryRun: boolean;
  ratingId?: number;
  afterId: number;
  limit?: number;
  batchSize: number;
}): Promise<boolean> {
  let ok = true;
  try {
    await levelsSequelize.authenticate();
    logger.info('Database connection established (levels)');

    const stats: ScriptStats = {
      total: 0,
      processed: 0,
      samples: 0,
      skippedAutorater: 0,
      skippedNoSettle: 0,
      failed: 0,
      errors: [],
    };

    const maxTotal = options.limit ?? Number.MAX_SAFE_INTEGER;
    let done = 0;
    let afterId = options.afterId;

    while (done < maxTotal) {
      const fetchLimit = Math.min(options.batchSize, maxTotal - done);
      const where: Record<string, unknown> = {
        confirmedAt: {[Op.ne]: null},
        id: {[Op.gt]: afterId},
      };
      if (options.ratingId != null) {
        where.id = options.ratingId;
      }

      const ratings = await Rating.findAll({
        where,
        include: [
          {
            model: Level,
            as: 'level',
            attributes: ['id', 'diffId', 'clears'],
            required: false,
          },
        ],
        order: [['id', 'ASC']],
        limit: fetchLimit,
      });

      if (ratings.length === 0) break;

      stats.total += ratings.length;
      afterId = ratings[ratings.length - 1]!.id;

      for (const rating of ratings) {
        await processRating(rating, options.dryRun, stats);
        done += 1;
      }

      if (options.ratingId != null) break;
      if (ratings.length < fetchLimit) break;
    }

    if (!options.dryRun) {
      const rebuilt = await rebuildAllStats();
      logger.info(`Rebuilt stats rows: ${rebuilt}`);
      await invalidateRatingAccuracyCache();
    }

    logger.info('\n' + '='.repeat(60));
    logger.info('Rating accuracy backfill complete');
    logger.info(`Confirmed ratings seen: ${stats.total}`);
    logger.info(`Processed:              ${stats.processed}`);
    logger.info(`Samples upserted:       ${stats.samples}`);
    logger.info(`Autorater skipped:      ${stats.skippedAutorater}`);
    logger.info(`No settled diff:        ${stats.skippedNoSettle}`);
    logger.info(`Failed:                 ${stats.failed}`);
    logger.info('='.repeat(60));

    if (stats.errors.length > 0) {
      for (const err of stats.errors.slice(0, 50)) {
        logger.info(`  rating ${err.ratingId}: ${err.error}`);
      }
    }

    if (options.dryRun) {
      logger.info('\n[DRY RUN] No DB writes');
    }
  } catch (error) {
    ok = false;
    logger.error('Script failed:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  } finally {
    await levelsSequelize.close();
    logger.info('Database connections closed');
  }
  return ok;
}

const program = new Command();

program
  .name('backfill-rating-accuracy')
  .description('Upsert rating accuracy samples and career stats for confirmed ratings')
  .option('--dry-run', 'Log intended writes without changing the database', false)
  .option('--rating-id <id>', 'Process a single rating id', (v) => parseInt(v, 10))
  .option('--after-id <id>', 'Start after this rating id', (v) => parseInt(v, 10), 0)
  .option('--limit <n>', 'Max confirmed ratings to process', (v) => parseInt(v, 10))
  .option('--batch-size <n>', 'Ratings per fetch', (v) => parseInt(v, 10), 200)
  .action(async (opts) => {
    const ok = await main({
      dryRun: Boolean(opts.dryRun),
      ratingId: Number.isFinite(opts.ratingId) ? opts.ratingId : undefined,
      afterId: Number.isFinite(opts.afterId) ? opts.afterId : 0,
      limit: Number.isFinite(opts.limit) ? opts.limit : undefined,
      batchSize: Number.isFinite(opts.batchSize) && opts.batchSize > 0 ? opts.batchSize : 200,
    });
    process.exit(ok ? 0 : 1);
  });

program.parseAsync(process.argv);
