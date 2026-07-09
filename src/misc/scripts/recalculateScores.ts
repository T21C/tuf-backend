#!/usr/bin/env ts-node

/**
 * Recalculate pass scoreV2 (and optionally accuracy) using scoreService.
 *
 * Usage (from server/):
 *   npx tsx src/misc/scripts/recalculateScores.ts --dry-run
 *   npx tsx src/misc/scripts/recalculateScores.ts --custom-curve-only --reindex
 *   npx tsx src/misc/scripts/recalculateScores.ts --level-id 9611
 *   npx tsx src/misc/scripts/recalculateScores.ts --pass-id 12345
 *   npx tsx src/misc/scripts/recalculateScores.ts --player-id 42 --limit 500
 *   npx tsx src/misc/scripts/recalculateScores.ts --after-pass-id 10000 --limit 2000 --batch-size 500
 */

import { Command } from 'commander';
import dotenv from 'dotenv';
import { Op, type WhereOptions } from 'sequelize';

dotenv.config();

import sequelize from '@/config/db.js';
import Level from '@/models/levels/Level.js';
import Pass from '@/models/passes/Pass.js';
import Difficulty from '@/models/levels/Difficulty.js';
import Judgement from '@/models/passes/Judgement.js';
import { initializeAssociations } from '@/models/associations.js';
import { computePassScoreV2 } from '@/misc/utils/pass/scoreService.js';
import type { IJudgements } from '@/misc/utils/pass/CalcAcc.js';
import { logger } from '@/server/services/core/LoggerService.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';

initializeAssociations();

const DEFAULT_JUDGEMENTS: IJudgements = {
  earlyDouble: 0,
  earlySingle: 0,
  ePerfect: 5,
  perfect: 40,
  lPerfect: 5,
  lateSingle: 0,
  lateDouble: 0,
};

interface RecalcOptions {
  dryRun: boolean;
  passId?: number;
  playerId?: number;
  levelId?: number;
  customCurveOnly: boolean;
  afterPassId: number;
  limit?: number;
  batchSize: number;
  changeThreshold: number;
  includeDeleted: boolean;
  updateAccuracy: boolean;
  reindex: boolean;
  logUnchanged: boolean;
}

interface RecalcStats {
  matched: number;
  processed: number;
  changed: number;
  unchanged: number;
  skipped: number;
  errors: number;
  passIds: number[];
  playerIds: Set<number>;
}

async function resolveLevelIds(options: RecalcOptions): Promise<number[] | undefined> {
  if (options.levelId != null) {
    return [options.levelId];
  }
  if (!options.customCurveOnly) {
    return undefined;
  }

  const levels = await Level.findAll({
    attributes: ['id'],
    where: { xaccCurveMeta: { [Op.ne]: null } },
  });
  const ids = levels.map(l => l.id);
  if (ids.length === 0) {
    logger.info('No levels with custom xacc curves found.');
  } else {
    logger.info(`Custom-curve filter: ${ids.length} level(s).`);
  }
  return ids;
}

function buildPassWhere(
  options: RecalcOptions,
  levelIds?: number[],
): WhereOptions {
  const where: WhereOptions = {};

  if (!options.includeDeleted) {
    where.isDeleted = false;
  }
  if (options.passId != null) {
    where.id = options.passId;
  } else if (options.afterPassId > 0) {
    where.id = {[Op.gt]: options.afterPassId};
  }
  if (options.playerId != null) {
    where.playerId = options.playerId;
  }
  if (options.levelId != null) {
    where.levelId = options.levelId;
  } else if (levelIds != null) {
    where.levelId = {[Op.in]: levelIds.length > 0 ? levelIds : [-1]};
  }

  return where;
}

async function countPasses(
  where: WhereOptions,
  remainingLimit?: number,
): Promise<number> {
  const total = await Pass.count({ where });
  if (remainingLimit != null) {
    return Math.min(total, remainingLimit);
  }
  return total;
}

async function recalculateScores(options: RecalcOptions): Promise<boolean> {
  const stats: RecalcStats = {
    matched: 0,
    processed: 0,
    changed: 0,
    unchanged: 0,
    skipped: 0,
    errors: 0,
    passIds: [],
    playerIds: new Set(),
  };

  const levelIds = await resolveLevelIds(options);
  if (options.customCurveOnly && levelIds?.length === 0) {
    return true;
  }

  const passWhere = buildPassWhere(options, levelIds);
  const totalToProcess = await countPasses(passWhere, options.limit);
  stats.matched = totalToProcess;

  if (totalToProcess === 0) {
    logger.info('No passes matched the current filters.');
    return true;
  }

  logger.info('Starting score recalculation…');
  logger.info(`Matched ${totalToProcess} pass(es).`);
  if (options.dryRun) {
    logger.info('[DRY RUN] No database or Elasticsearch writes will be performed.');
  }

  let cursor = options.afterPassId;
  let remaining = options.limit ?? totalToProcess;

  while (remaining > 0) {
    const take = Math.min(options.batchSize, remaining);
    const batchWhere: WhereOptions = {...passWhere};
    if (options.passId == null && cursor > 0) {
      Object.assign(batchWhere, {id: {[Op.gt]: cursor}});
    }

    const passes = await Pass.findAll({
      limit: take,
      where: batchWhere,
      order: [['id', 'ASC']],
      include: [
        {
          model: Level,
          as: 'level',
          required: true,
          include: [{ model: Difficulty, as: 'difficulty', required: true }],
        },
        { model: Judgement, as: 'judgements', required: true },
      ],
    });

    if (passes.length === 0) {
      break;
    }

    const batchNum = Math.floor(stats.processed / options.batchSize) + 1;
    const batchTotal = Math.ceil(totalToProcess / options.batchSize);
    logger.info(`Processing batch ${batchNum}/${batchTotal} (${passes.length} pass(es))`);

    for (const pass of passes) {
      cursor = pass.id;
      remaining--;

      try {
        if (!pass.level) {
          stats.skipped++;
          logger.warn(`Pass ${pass.id}: skipped (missing level)`);
          continue;
        }

        const { scoreV2: newScore, accuracy: newAccuracy } = computePassScoreV2(
          {
            speed: pass.speed || 1,
            judgements: pass.judgements || DEFAULT_JUDGEMENTS,
            isNoHoldTap: pass.isNoHoldTap || false,
          },
          pass.level,
        );

        const currentScore = pass.scoreV2 ?? 0;
        const scoreChanged =
          Math.abs(currentScore - newScore) > options.changeThreshold;
        const accuracyChanged =
          options.updateAccuracy &&
          Math.abs((pass.accuracy ?? 0) - newAccuracy) > 1e-9;

        if (!scoreChanged && !accuracyChanged) {
          stats.unchanged++;
          if (options.logUnchanged) {
            logger.info(`Pass ${pass.id}: unchanged (${currentScore.toFixed(2)})`);
          }
        } else {
          stats.changed++;
          logger.info(
            `Pass ${pass.id} (level ${pass.levelId}): score ${currentScore.toFixed(2)} -> ${newScore.toFixed(2)}` +
              (options.updateAccuracy && accuracyChanged
                ? `, accuracy ${(pass.accuracy ?? 0).toFixed(4)} -> ${newAccuracy.toFixed(4)}`
                : ''),
          );

          if (!options.dryRun) {
            await pass.update({
              scoreV2: newScore,
              ...(options.updateAccuracy ? { accuracy: newAccuracy } : {}),
            });
          }

          stats.passIds.push(pass.id);
          if (pass.playerId) {
            stats.playerIds.add(pass.playerId);
          }
        }

        stats.processed++;
      } catch (error) {
        stats.errors++;
        logger.error(`Pass ${pass.id}:`, error);
      }

      if (remaining <= 0) {
        break;
      }
    }

    if (options.passId != null) {
      break;
    }
  }

  logger.info('\nRecalculation summary:');
  logger.info(`  Matched:   ${stats.matched}`);
  logger.info(`  Processed: ${stats.processed}`);
  logger.info(`  Changed:   ${stats.changed}`);
  logger.info(`  Unchanged: ${stats.unchanged}`);
  logger.info(`  Skipped:   ${stats.skipped}`);
  logger.info(`  Errors:    ${stats.errors}`);
  if (cursor > options.afterPassId && options.passId == null) {
    logger.info(`  Last pass id: ${cursor} (use --after-pass-id ${cursor} to resume)`);
  }

  if (options.reindex && !options.dryRun && stats.passIds.length > 0) {
    const elasticsearchService = ElasticsearchService.getInstance();
    logger.info(`Reindexing ${stats.passIds.length} pass(es)…`);
    await elasticsearchService.reindexPasses(stats.passIds);
    if (stats.playerIds.size > 0) {
      logger.info(`Reindexing ${stats.playerIds.size} player(s)…`);
      await elasticsearchService.reindexPlayers(Array.from(stats.playerIds));
    }
  }

  return stats.errors === 0;
}

const program = new Command();

program
  .name('recalculate-scores')
  .description('Recalculate pass scoreV2 using the current scoreService pipeline')
  .option('-d, --dry-run', 'Log changes only; do not write to DB or Elasticsearch', false)
  .option('--pass-id <id>', 'Recalculate a single pass', (v) => parseInt(v, 10))
  .option('--player-id <id>', 'Only passes for this player', (v) => parseInt(v, 10))
  .option('--level-id <id>', 'Only passes on this level', (v) => parseInt(v, 10))
  .option(
    '--custom-curve-only',
    'Only passes on levels with a custom xacc curve (xaccCurveMeta IS NOT NULL)',
    false,
  )
  .option(
    '--after-pass-id <id>',
    'Only passes with id greater than this (resume cursor)',
    (v) => parseInt(v, 10),
    0,
  )
  .option('-l, --limit <number>', 'Maximum passes to process')
  .option('-b, --batch-size <number>', 'Passes per fetch batch', (v) => parseInt(v, 10), 500)
  .option(
    '--change-threshold <number>',
    'Treat score delta above this as a change (logging / reindex selection)',
    (v) => parseFloat(v),
    0.01,
  )
  .option('--include-deleted', 'Include deleted passes', false)
  .option('--update-accuracy', 'Also persist recalculated accuracy', false)
  .option('--reindex', 'Reindex affected passes and players in Elasticsearch', false)
  .option('--log-unchanged', 'Log passes whose score did not change', false)
  .action(async (opts) => {
    let ok = false;
    try {
      await sequelize.authenticate();
      logger.info('Database connection established.');

      ok = await recalculateScores({
        dryRun: Boolean(opts.dryRun),
        passId: Number.isFinite(opts.passId) ? opts.passId : undefined,
        playerId: Number.isFinite(opts.playerId) ? opts.playerId : undefined,
        levelId: Number.isFinite(opts.levelId) ? opts.levelId : undefined,
        customCurveOnly: Boolean(opts.customCurveOnly),
        afterPassId:
          Number.isFinite(opts.afterPassId) && opts.afterPassId > 0
            ? opts.afterPassId
            : 0,
        limit: Number.isFinite(opts.limit) ? opts.limit : undefined,
        batchSize:
          Number.isFinite(opts.batchSize) && opts.batchSize > 0
            ? opts.batchSize
            : 500,
        changeThreshold:
          Number.isFinite(opts.changeThreshold) && opts.changeThreshold >= 0
            ? opts.changeThreshold
            : 0.01,
        includeDeleted: Boolean(opts.includeDeleted),
        updateAccuracy: Boolean(opts.updateAccuracy),
        reindex: Boolean(opts.reindex),
        logUnchanged: Boolean(opts.logUnchanged),
      });
    } catch (error) {
      logger.error('Script failed:', error);
      ok = false;
    } finally {
      await sequelize.close();
      logger.info('Database connection closed.');
    }
    process.exit(ok ? 0 : 1);
  });

program.parse(process.argv);
