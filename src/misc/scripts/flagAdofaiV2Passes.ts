/**
 * Flag passes recorded before the ADOFAI v3 release (ADOFAI v2 era).
 *
 * Bulk mode: flags all passes where vidUploadTime < --before-date.
 * One-offs: use admin pass edit, or --pass-id with optional --unflag.
 *
 * Usage (from server/):
 *   npx tsx src/misc/scripts/flagAdofaiV2Passes.ts --before-date 2026-05-01
 *   npx tsx src/misc/scripts/flagAdofaiV2Passes.ts --before-date 2026-05-01 --apply
 *   npx tsx src/misc/scripts/flagAdofaiV2Passes.ts --pass-id 99999 --unflag --apply
 */

import {parseArgs} from 'node:util';
import dotenv from 'dotenv';
import {QueryTypes} from 'sequelize';

dotenv.config();

import {getSequelizeForModelGroup} from '@/config/db.js';
import {initializeAssociations} from '@/models/associations.js';
import {logger} from '@/server/services/core/LoggerService.js';

initializeAssociations();

const passesSequelize = getSequelizeForModelGroup('passes');

interface CliOptions {
  passId?: number;
  beforeDate?: string;
  unflag: boolean;
  apply: boolean;
  limit?: number;
  batchSize: number;
}

interface PassRow {
  id: number;
  playerId: number;
  levelId: number;
  vidUploadTime: Date | string | null;
  isAdofaiV2: boolean | number | null;
}

function parseDateCutoff(dateStr: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`Invalid --before-date "${dateStr}"; expected YYYY-MM-DD`);
  }
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}

function buildWhereClause(opts: CliOptions): {sql: string; replacements: Record<string, unknown>} {
  const parts: string[] = [];
  const replacements: Record<string, unknown> = {
    flagValue: opts.unflag ? 0 : 1,
  };

  parts.push('IFNULL(p.isDeleted, 0) = 0');
  parts.push('IFNULL(p.isHidden, 0) = 0');

  if (opts.passId != null) {
    parts.push('p.id = :passId');
    replacements.passId = opts.passId;
  } else {
    if (!opts.beforeDate) {
      throw new Error('Bulk mode requires --before-date YYYY-MM-DD');
    }
    parts.push('p.vidUploadTime IS NOT NULL');
    parts.push('p.vidUploadTime < :cutoff');
    replacements.cutoff = parseDateCutoff(opts.beforeDate);
  }

  parts.push('IFNULL(p.isAdofaiV2, 0) != :flagValue');

  return {sql: parts.join(' AND '), replacements};
}

async function countMatching(opts: CliOptions): Promise<number> {
  const {sql, replacements} = buildWhereClause(opts);
  const rows = (await passesSequelize.query(
    `SELECT COUNT(*) AS cnt FROM passes p WHERE ${sql}`,
    {replacements, type: QueryTypes.SELECT},
  )) as Array<{cnt: number | string | bigint}>;
  const cnt = rows[0]?.cnt;
  if (typeof cnt === 'bigint') return Number(cnt);
  return Number(cnt ?? 0);
}

async function fetchSample(opts: CliOptions, sampleLimit: number): Promise<PassRow[]> {
  const {sql, replacements} = buildWhereClause(opts);
  return (await passesSequelize.query(
    `
    SELECT p.id, p.playerId, p.levelId, p.vidUploadTime, p.isAdofaiV2
    FROM passes p
    WHERE ${sql}
    ORDER BY p.id ASC
    LIMIT :sampleLimit
    `,
    {
      replacements: {...replacements, sampleLimit},
      type: QueryTypes.SELECT,
    },
  )) as PassRow[];
}

async function applyUpdates(opts: CliOptions): Promise<number> {
  const {sql, replacements} = buildWhereClause(opts);
  let totalUpdated = 0;
  let batchNum = 0;

  for (;;) {
    const batch = (await passesSequelize.query(
      `
      SELECT p.id
      FROM passes p
      WHERE ${sql}
      ORDER BY p.id ASC
      LIMIT :batchSize
      `,
      {
        replacements: {...replacements, batchSize: opts.batchSize},
        type: QueryTypes.SELECT,
      },
    )) as Array<{id: number}>;

    if (batch.length === 0) break;

    const ids = batch.map((r) => r.id);
    const [, meta] = await passesSequelize.query(
      `
      UPDATE passes
      SET isAdofaiV2 = :flagValue, updatedAt = NOW()
      WHERE id IN (:ids)
      `,
      {replacements: {ids, flagValue: replacements.flagValue}},
    );
    const affected = (meta as {affectedRows?: number})?.affectedRows ?? ids.length;
    totalUpdated += affected;
    batchNum++;

    logger.info('Batch updated', {batchNum, batchSize: ids.length, totalUpdated});

    if (opts.limit != null && totalUpdated >= opts.limit) break;
    if (batch.length < opts.batchSize) break;
  }

  return totalUpdated;
}

async function parseCli(): Promise<CliOptions> {
  const {values} = parseArgs({
    options: {
      'pass-id': {type: 'string'},
      'before-date': {type: 'string'},
      unflag: {type: 'boolean', default: false},
      apply: {type: 'boolean', default: false},
      limit: {type: 'string'},
      'batch-size': {type: 'string', default: '500'},
    },
    allowPositionals: false,
  });

  const passIdRaw = values['pass-id'];
  const passId = passIdRaw != null ? Number(passIdRaw) : undefined;
  if (passIdRaw != null && (!Number.isInteger(passId) || passId! <= 0)) {
    throw new Error(`Invalid --pass-id "${passIdRaw}"`);
  }

  const limitRaw = values.limit;
  const limit = limitRaw != null ? Number(limitRaw) : undefined;
  if (limitRaw != null && (!Number.isInteger(limit) || limit! <= 0)) {
    throw new Error(`Invalid --limit "${limitRaw}"`);
  }

  const batchSize = Number(values['batch-size']);
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`Invalid --batch-size "${values['batch-size']}"`);
  }

  if (passId == null && !values['before-date']) {
    throw new Error('Provide --before-date for bulk mode or --pass-id for a single pass');
  }

  return {
    passId,
    beforeDate: values['before-date'],
    unflag: values.unflag ?? false,
    apply: values.apply ?? false,
    limit,
    batchSize,
  };
}

async function main(): Promise<void> {
  const opts = await parseCli();
  const mode = opts.passId != null ? 'single-pass' : 'bulk';
  const action = opts.unflag ? 'unflag' : 'flag';

  logger.info('ADOFAI v2 pass flag script', {
    mode,
    action,
    apply: opts.apply,
    passId: opts.passId,
    beforeDate: opts.beforeDate,
    limit: opts.limit,
    batchSize: opts.batchSize,
  });

  const total = await countMatching(opts);
  const sample = await fetchSample(opts, 20);

  logger.info('Dry-run summary', {
    matchingPasses: total,
    sampleRows: sample.map((r) => ({
      id: r.id,
      playerId: r.playerId,
      levelId: r.levelId,
      vidUploadTime: r.vidUploadTime,
      currentIsAdofaiV2: r.isAdofaiV2,
    })),
  });

  if (!opts.apply) {
    logger.info('Dry-run only — pass --apply to write changes');
    return;
  }

  if (total === 0) {
    logger.info('No matching passes to update');
    return;
  }

  const updated = await applyUpdates(opts);
  logger.info('Done', {updated, action});
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error('flagAdofaiV2Passes failed', {error: err});
    console.error(err);
    process.exit(1);
  });
