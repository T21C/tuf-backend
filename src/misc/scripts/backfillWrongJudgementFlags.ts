/**
 * Set `passes.isWrongJudgement` when judgement hit totals do not match
 * `levels.tilecount - autoTileCount`. Dry-run by default.
 *
 * Usage (from server/):
 *   npx tsx src/misc/scripts/backfillWrongJudgementFlags.ts
 *   npx tsx src/misc/scripts/backfillWrongJudgementFlags.ts --apply
 *   npx tsx src/misc/scripts/backfillWrongJudgementFlags.ts --pass-id 123 --apply
 *   npx tsx src/misc/scripts/backfillWrongJudgementFlags.ts --after-id 1000 --limit 200 --apply
 *   npx tsx src/misc/scripts/backfillWrongJudgementFlags.ts --apply --skip-reindex
 */

import {parseArgs} from 'node:util';
import dotenv from 'dotenv';
import {Op, QueryTypes} from 'sequelize';

dotenv.config();

import {getSequelizeForModelGroup} from '@/config/db.js';
import {initializeAssociations} from '@/models/associations.js';
import Pass from '@/models/passes/Pass.js';
import {logger} from '@/server/services/core/LoggerService.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {emptyJudgements, isWrongJudgement} from '@/misc/utils/pass/CalcAcc.js';

initializeAssociations();

const passesSequelize = getSequelizeForModelGroup('passes');

const DEFAULT_BATCH_SIZE = 500;

interface CliOptions {
  apply: boolean;
  skipReindex: boolean;
  passId?: number;
  afterId: number;
  limit?: number;
  batchSize: number;
}

interface PassChartRow {
  id: number;
  isWrongJudgement: boolean | number | string | null;
  tilecount: number | string | null;
  autoTileCount: number | string | null;
  earlySingle: string | number;
  ePerfect: string | number;
  perfectMinus: string | number;
  perfect: string | number;
  perfectPlus: string | number;
  lPerfect: string | number;
  lateSingle: string | number;
}

function parsePositiveInt(raw: string | undefined, flag: string): number | undefined {
  if (raw == null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${flag} "${raw}"`);
  }
  return value;
}

function parseCli(): CliOptions {
  const {values} = parseArgs({
    options: {
      apply: {type: 'boolean', default: false},
      'skip-reindex': {type: 'boolean', default: false},
      'pass-id': {type: 'string'},
      'after-id': {type: 'string'},
      limit: {type: 'string'},
      'batch-size': {type: 'string'},
    },
    allowPositionals: false,
  });

  return {
    apply: values.apply ?? false,
    skipReindex: values['skip-reindex'] ?? false,
    passId: parsePositiveInt(values['pass-id'], '--pass-id'),
    afterId: parsePositiveInt(values['after-id'], '--after-id') ?? 0,
    limit: parsePositiveInt(values.limit, '--limit'),
    batchSize: parsePositiveInt(values['batch-size'], '--batch-size') ?? DEFAULT_BATCH_SIZE,
  };
}

function flagBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function desiredFlag(row: PassChartRow): boolean {
  const judgements = emptyJudgements();
  judgements.earlySingle = Number(row.earlySingle) || 0;
  judgements.ePerfect = Number(row.ePerfect) || 0;
  judgements.perfectMinus = Number(row.perfectMinus) || 0;
  judgements.perfect = Number(row.perfect) || 0;
  judgements.perfectPlus = Number(row.perfectPlus) || 0;
  judgements.lPerfect = Number(row.lPerfect) || 0;
  judgements.lateSingle = Number(row.lateSingle) || 0;
  return isWrongJudgement(judgements, {
    tilecount: row.tilecount,
    autoTileCount: row.autoTileCount,
  });
}

async function fetchBatch(opts: CliOptions, afterId: number): Promise<PassChartRow[]> {
  const replacements: Record<string, unknown> = {
    afterId,
    limit: opts.batchSize,
  };
  const filters = ['p.id > :afterId'];
  if (opts.passId != null) {
    filters.push('p.id = :passId');
    replacements.passId = opts.passId;
  }

  return (await passesSequelize.query(
    `
    SELECT p.id, p.isWrongJudgement,
           l.tilecount, l.autoTileCount,
           j.earlySingle, j.ePerfect, j.perfectMinus, j.perfect,
           j.perfectPlus, j.lPerfect, j.lateSingle
    FROM passes p
    INNER JOIN judgements j ON j.id = p.id
    INNER JOIN levels l ON l.id = p.levelId
    WHERE ${filters.join(' AND ')}
    ORDER BY p.id ASC
    LIMIT :limit
    `,
    {replacements, type: QueryTypes.SELECT},
  )) as PassChartRow[];
}

async function updateFlag(ids: number[], value: boolean): Promise<void> {
  if (ids.length === 0) return;
  await Pass.update({isWrongJudgement: value}, {where: {id: {[Op.in]: ids}}});
}

async function main(): Promise<void> {
  const opts = parseCli();
  await passesSequelize.authenticate();

  logger.info('backfillWrongJudgementFlags start', {
    apply: opts.apply,
    skipReindex: opts.skipReindex,
    passId: opts.passId ?? null,
    afterId: opts.afterId,
    limit: opts.limit ?? null,
    batchSize: opts.batchSize,
  });

  let afterId = opts.afterId;
  let scanned = 0;
  let wouldSetTrue = 0;
  let wouldSetFalse = 0;
  const touchedIds: number[] = [];
  const preview: Array<{id: number; from: boolean; to: boolean}> = [];

  for (;;) {
    if (opts.limit != null && scanned >= opts.limit) break;
    const remaining = opts.limit != null ? opts.limit - scanned : opts.batchSize;
    const batchOpts = remaining < opts.batchSize ? {...opts, batchSize: remaining} : opts;
    const batch = await fetchBatch(batchOpts, afterId);
    if (batch.length === 0) break;

    const toTrue: number[] = [];
    const toFalse: number[] = [];
    for (const row of batch) {
      const next = desiredFlag(row);
      const prev = flagBool(row.isWrongJudgement);
      if (next === prev) continue;
      if (next) {
        toTrue.push(row.id);
        wouldSetTrue++;
      } else {
        toFalse.push(row.id);
        wouldSetFalse++;
      }
      if (preview.length < 20) {
        preview.push({id: row.id, from: prev, to: next});
      }
    }

    if (opts.apply) {
      await updateFlag(toTrue, true);
      await updateFlag(toFalse, false);
      touchedIds.push(...toTrue, ...toFalse);
    }

    scanned += batch.length;
    afterId = Number(batch[batch.length - 1].id);
    logger.info('Batch scanned', {
      scanned,
      lastId: afterId,
      wouldSetTrue,
      wouldSetFalse,
    });

    if (batch.length < batchOpts.batchSize) break;
  }

  for (const row of preview) {
    logger.info(`pass ${row.id}: ${row.from} -> ${row.to}`);
  }

  if (!opts.apply) {
    logger.info(
      `Dry-run only — scanned ${scanned} pass(es); would set true=${wouldSetTrue}, false=${wouldSetFalse}. Pass --apply to write changes`,
    );
    return;
  }

  logger.info('Backfill writes done', {
    scanned,
    setTrue: wouldSetTrue,
    setFalse: wouldSetFalse,
    touched: touchedIds.length,
  });

  if (!opts.skipReindex && touchedIds.length > 0) {
    const elasticsearchService = ElasticsearchService.getInstance();
    logger.info(`Reindexing ${touchedIds.length} pass(es)`);
    await elasticsearchService.reindexPasses(touchedIds);
  }
}

main()
  .then(async () => {
    await passesSequelize.close();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error('backfillWrongJudgementFlags failed', {error: err});
    console.error(err);
    await passesSequelize.close().catch(() => {});
    process.exit(1);
  });
