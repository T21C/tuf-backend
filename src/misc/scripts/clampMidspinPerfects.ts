/**
 * Subtract in-game midspin Perfects from legacy-era passes and set
 * MIDSPIN_PERFECTS_REMOVED. Dry-run by default; write a skip CSV.
 *
 * Prerequisite: chart reparse so levels.tilecount is in-game count and midspinCount is populated.
 *
 * Usage (from server/):
 *   npx tsx src/misc/scripts/clampMidspinPerfects.ts
 *   npx tsx src/misc/scripts/clampMidspinPerfects.ts --apply --reindex
 *   npx tsx src/misc/scripts/clampMidspinPerfects.ts --out-csv ./midspin-perfect-skips.csv
 */

import {Command} from 'commander';
import {writeFile} from 'node:fs/promises';
import dotenv from 'dotenv';
import {Op, type WhereOptions} from 'sequelize';

dotenv.config();

import sequelize from '@/config/db.js';
import Level from '@/models/levels/Level.js';
import Pass from '@/models/passes/Pass.js';
import Difficulty from '@/models/levels/Difficulty.js';
import Judgement from '@/models/passes/Judgement.js';
import {initializeAssociations} from '@/models/associations.js';
import {computePassScoreV2} from '@/misc/utils/pass/scoreService.js';
import {logger} from '@/server/services/core/LoggerService.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {isCdnUrl} from '@/misc/utils/Utility.js';
import {tilecount as judgementHitCount, unwrapJudgements} from '@/misc/utils/pass/CalcAcc.js';
import {
  applyMidspinPerfectDecrement,
  classifyMidspinRewrite,
} from '@/misc/utils/pass/midspinPerfectDecrement.js';
import {ADOFAI_VERSION, parseAdofaiVersion} from '@/misc/utils/pass/adofaiVersion.js';
import {addPassMetaFlag, passMetaFlags, passMetaFlagsToDb} from '@/misc/utils/pass/passMetaFlags.js';

initializeAssociations();

interface CliOptions {
  apply: boolean;
  reindex: boolean;
  outCsv: string;
  passId?: number;
  levelId?: number;
  afterPassId: number;
  limit?: number;
  batchSize: number;
  includeDeleted: boolean;
  includeFlagged: boolean;
}

interface SkipRow {
  reason: string;
  passId: number;
  levelId: number;
  tilecount: string;
  midspin: string;
  hits: string;
  perfect: string;
  dlLink: string;
}

function csvEscape(s: string): string {
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowToCsvLine(cols: string[]): string {
  return cols.map(csvEscape).join(',') + '\n';
}

function hasCdnDownload(dlLink: unknown): boolean {
  return typeof dlLink === 'string' && dlLink !== '' && dlLink !== 'removed' && isCdnUrl(dlLink);
}

function displayNum(v: unknown): string {
  if (v == null || v === '') return '';
  return String(v);
}

function buildWhere(options: CliOptions): WhereOptions {
  const where: WhereOptions = {
    adofaiVersion: {[Op.in]: [ADOFAI_VERSION.V2, ADOFAI_VERSION.PRE_3_4_0]},
  };
  if (!options.includeDeleted) {
    where.isDeleted = false;
  }
  if (options.passId != null) {
    where.id = options.passId;
  } else if (options.afterPassId > 0) {
    where.id = {[Op.gt]: options.afterPassId};
  }
  if (options.levelId != null) {
    where.levelId = options.levelId;
  }
  if (!options.includeFlagged) {
    Object.assign(where, {
      [Op.and]: [sequelize.literal('(IFNULL(passMetaFlags, 0) & 1) = 0')],
    });
  }
  return where;
}

async function clampMidspinPerfects(options: CliOptions): Promise<boolean> {
  const skips: SkipRow[] = [];
  const touchedPassIds: number[] = [];
  const touchedPlayerIds = new Set<number>();
  const stats = {
    matched: 0,
    processed: 0,
    subtracted: 0,
    flagOnly: 0,
    silent: 0,
    csvSkip: 0,
    errors: 0,
  };

  const passWhere = buildWhere(options);
  const total = await Pass.count({where: passWhere});
  const totalToProcess = options.limit != null ? Math.min(total, options.limit) : total;
  stats.matched = totalToProcess;

  logger.info('Starting midspin Perfect rewrite…');
  logger.info(`Matched ${totalToProcess} legacy-era pass(es) without the rewrite bit.`);
  if (!options.apply) {
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
          include: [{model: Difficulty, as: 'difficulty', required: true}],
        },
        {model: Judgement, as: 'judgements', required: true},
      ],
    });

    if (passes.length === 0) {
      break;
    }

    for (const pass of passes) {
      cursor = pass.id;
      remaining--;
      stats.processed++;

      try {
        const level = pass.level;
        const judgements = pass.judgements;
        if (!level || !judgements) {
          stats.errors++;
          logger.warn(`Pass ${pass.id}: skipped (missing level or judgements)`);
          continue;
        }

        const classification = classifyMidspinRewrite({
          adofaiVersion: parseAdofaiVersion(pass.adofaiVersion),
          passMetaFlags: pass.passMetaFlags,
          hasCdnDownload: hasCdnDownload(level.dlLink),
          midspinCount: (level as {midspinCount?: unknown}).midspinCount,
          tilecount: (level as {tilecount?: unknown}).tilecount,
          judgements,
        });

        if (classification.action === 'skip_silent') {
          stats.silent++;
          continue;
        }

        if (classification.action === 'skip_csv') {
          stats.csvSkip++;
          skips.push({
            reason: classification.reason,
            passId: pass.id,
            levelId: pass.levelId,
            tilecount: displayNum((level as {tilecount?: unknown}).tilecount),
            midspin: displayNum((level as {midspinCount?: unknown}).midspinCount),
            hits: String(judgementHitCount(judgements)),
            perfect: String(unwrapJudgements(judgements).perfect),
            dlLink: typeof level.dlLink === 'string' ? level.dlLink : '',
          });
          continue;
        }

        if (classification.action === 'flag_only') {
          stats.flagOnly++;
          const nextFlags = addPassMetaFlag(pass.passMetaFlags, passMetaFlags.MIDSPIN_PERFECTS_REMOVED);
          logger.info(`Pass ${pass.id} (level ${pass.levelId}): set MIDSPIN_PERFECTS_REMOVED (no count change)`);
          if (options.apply) {
            await pass.update({passMetaFlags: passMetaFlagsToDb(nextFlags)});
            touchedPassIds.push(pass.id);
            if (pass.playerId) touchedPlayerIds.add(pass.playerId);
          }
          continue;
        }

        const decrement = applyMidspinPerfectDecrement({
          judgements,
          adofaiVersion: parseAdofaiVersion(pass.adofaiVersion),
          passMetaFlags: pass.passMetaFlags,
          midspinCount: (level as {midspinCount?: unknown}).midspinCount,
        });
        if (!decrement.applied) {
          stats.csvSkip++;
          skips.push({
            reason: decrement.skippedReason || 'inexact',
            passId: pass.id,
            levelId: pass.levelId,
            tilecount: displayNum((level as {tilecount?: unknown}).tilecount),
            midspin: displayNum((level as {midspinCount?: unknown}).midspinCount),
            hits: String(judgementHitCount(judgements)),
            perfect: String(unwrapJudgements(judgements).perfect),
            dlLink: typeof level.dlLink === 'string' ? level.dlLink : '',
          });
          continue;
        }

        const {accuracy: newAcc, scoreV2: newScore} = computePassScoreV2(
          {
            speed: pass.speed ?? 1,
            judgements: decrement.judgements,
            isNoHoldTap: pass.isNoHoldTap ?? false,
          },
          level,
        );

        stats.subtracted++;
        logger.info(
          `Pass ${pass.id} (level ${pass.levelId}): perfect ${unwrapJudgements(judgements).perfect} -> ${decrement.judgements.perfect}` +
            `, accuracy ${(pass.accuracy ?? 0).toFixed(4)} -> ${newAcc.toFixed(4)}` +
            `, score ${(pass.scoreV2 ?? 0).toFixed(2)} -> ${newScore.toFixed(2)}`,
        );

        if (options.apply) {
          await judgements.update({
            perfect: decrement.judgements.perfect,
            accuracy: newAcc,
          });
          await pass.update({
            accuracy: newAcc,
            scoreV2: newScore,
            passMetaFlags: passMetaFlagsToDb(decrement.passMetaFlags),
          });
          touchedPassIds.push(pass.id);
          if (pass.playerId) touchedPlayerIds.add(pass.playerId);
        }
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

  const csvHeader = rowToCsvLine([
    'reason',
    'passId',
    'levelId',
    'tilecount',
    'midspin',
    'hits',
    'perfect',
    'dlLink',
  ]);
  const csvBody = skips
    .map((row) =>
      rowToCsvLine([
        row.reason,
        String(row.passId),
        String(row.levelId),
        row.tilecount,
        row.midspin,
        row.hits,
        row.perfect,
        row.dlLink,
      ]),
    )
    .join('');
  await writeFile(options.outCsv, csvHeader + csvBody, 'utf8');
  logger.info(`Wrote ${skips.length} skip row(s) to ${options.outCsv}`);

  logger.info('\nMidspin rewrite summary:');
  logger.info(`  Matched:     ${stats.matched}`);
  logger.info(`  Processed:   ${stats.processed}`);
  logger.info(`  Subtracted:  ${stats.subtracted}`);
  logger.info(`  Flag only:   ${stats.flagOnly}`);
  logger.info(`  Silent skip: ${stats.silent}`);
  logger.info(`  CSV skip:    ${stats.csvSkip}`);
  logger.info(`  Errors:      ${stats.errors}`);
  if (cursor > options.afterPassId && options.passId == null) {
    logger.info(`  Last pass id: ${cursor} (use --after-pass-id ${cursor} to resume)`);
  }

  if (options.apply && options.reindex && touchedPassIds.length > 0) {
    const elasticsearchService = ElasticsearchService.getInstance();
    logger.info(`Reindexing ${touchedPassIds.length} pass(es)…`);
    await elasticsearchService.reindexPasses(touchedPassIds);
    if (touchedPlayerIds.size > 0) {
      logger.info(`Reindexing ${touchedPlayerIds.size} player(s)…`);
      await elasticsearchService.reindexPlayers(Array.from(touchedPlayerIds));
    }
  }

  return stats.errors === 0;
}

const program = new Command();

program
  .name('clamp-midspin-perfects')
  .description('Subtract midspin Perfects from v2 / pre-3.4.0 passes and set MIDSPIN_PERFECTS_REMOVED')
  .option('--apply', 'Write judgement, flag, accuracy, and score changes', false)
  .option('--reindex', 'Reindex affected passes and players after apply', true)
  .option('--out-csv <path>', 'CSV of skipped passes', 'midspin-perfect-skips.csv')
  .option('--pass-id <id>', 'Process a single pass', (v) => parseInt(v, 10))
  .option('--level-id <id>', 'Only passes on this level', (v) => parseInt(v, 10))
  .option(
    '--after-pass-id <id>',
    'Only passes with id greater than this (resume cursor)',
    (v) => parseInt(v, 10),
    0,
  )
  .option('-l, --limit <number>', 'Maximum passes to process')
  .option('-b, --batch-size <number>', 'Passes per fetch batch', (v) => parseInt(v, 10), 200)
  .option('--include-deleted', 'Include deleted passes', false)
  .option('--include-flagged', 'Scan rows that already have MIDSPIN_PERFECTS_REMOVED', false)
  .action(async (opts) => {
    let ok = false;
    try {
      await sequelize.authenticate();
      logger.info('Database connection established.');

      ok = await clampMidspinPerfects({
        apply: Boolean(opts.apply),
        reindex: opts.reindex !== false,
        outCsv: typeof opts.outCsv === 'string' && opts.outCsv ? opts.outCsv : 'midspin-perfect-skips.csv',
        passId: Number.isFinite(opts.passId) ? opts.passId : undefined,
        levelId: Number.isFinite(opts.levelId) ? opts.levelId : undefined,
        afterPassId:
          Number.isFinite(opts.afterPassId) && opts.afterPassId > 0 ? opts.afterPassId : 0,
        limit: Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : undefined,
        batchSize:
          Number.isFinite(opts.batchSize) && opts.batchSize > 0 ? opts.batchSize : 200,
        includeDeleted: Boolean(opts.includeDeleted),
        includeFlagged: Boolean(opts.includeFlagged),
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
