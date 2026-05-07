/**
 * Audit pass judgement totals vs `levels.tilecount`, optionally clamp inflated
 * perfects-only passes, and flag levels where non-pure-perfect passes mismatch
 * tilecount (possible wrong level selected).
 *
 * Usage (from server/):
 *   npx tsx src/misc/scripts/auditPassJudgements.ts --mode scan --margin 0
 *   npx tsx src/misc/scripts/auditPassJudgements.ts --mode clamp --margin 0
 *   npx tsx src/misc/scripts/auditPassJudgements.ts --mode clamp --margin 0 --apply
 *   npx tsx src/misc/scripts/auditPassJudgements.ts --mode flag-levels --level-flag-threshold 0.8 --min-passes 3 --out-csv ./suspect-levels.csv
 */

import {parseArgs} from 'node:util';
import {writeFile} from 'node:fs/promises';
import dotenv from 'dotenv';
import {QueryTypes, Transaction} from 'sequelize';

dotenv.config();

import {getSequelizeForModelGroup} from '@/config/db.js';
import {initializeAssociations} from '@/models/associations.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {safeTransactionRollback} from '@/misc/utils/Utility.js';
import Pass from '@/models/passes/Pass.js';
import Judgement from '@/models/passes/Judgement.js';
import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';
import {calcAcc, type IJudgements} from '@/misc/utils/pass/CalcAcc.js';
import {getScoreV2} from '@/misc/utils/pass/CalcScore.js';

initializeAssociations();

const passesSequelize = getSequelizeForModelGroup('passes');

type Mode = 'scan' | 'clamp' | 'flag-levels';

interface CliOptions {
  mode: Mode;
  margin: number;
  levelId?: number;
  playerId?: number;
  afterId: number;
  limit: number;
  batchSize: number;
  includeDeleted: boolean;
  includeHidden: boolean;
  apply: boolean;
  levelFlagThreshold: number;
  minPasses: number;
  outCsv?: string;
  outJson?: string;
}

interface MismatchPassRow {
  id: number;
  levelId: number;
  playerId: number;
  passAccuracy: number | null;
  tilecount: number;
  earlyDouble: string | number;
  earlySingle: string | number;
  ePerfect: string | number;
  perfect: string | number;
  lPerfect: string | number;
  lateSingle: string | number;
  lateDouble: string | number;
  judgementAccuracy: number | null;
  totalHits: string | number;
}

interface FlaggedLevelRow {
  levelId: number;
  song: string | null;
  artist: string | null;
  tilecount: number;
  nonPerfectPasses: number;
  mismatched: number;
  mismatchRate: number;
  minHits: number;
  maxHits: number;
  avgHits: number;
}

function num(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isPerfectsOnlyJudgementAccuracy(acc: number | null): boolean {
  if (acc == null || !Number.isFinite(acc)) return false;
  return Math.abs(acc - 1) < 1e-9;
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

function buildPassFilters(opts: CliOptions): {sql: string; replacements: Record<string, unknown>} {
  const parts: string[] = [];
  const replacements: Record<string, unknown> = {
    includeDeleted: opts.includeDeleted ? 1 : 0,
    includeHidden: opts.includeHidden ? 1 : 0,
  };

  parts.push('(:includeDeleted = 1 OR IFNULL(p.isDeleted, 0) = 0)');
  parts.push('(:includeHidden = 1 OR IFNULL(p.isHidden, 0) = 0)');

  if (opts.levelId != null) {
    parts.push('p.levelId = :levelId');
    replacements.levelId = opts.levelId;
  }
  if (opts.playerId != null) {
    parts.push('p.playerId = :playerId');
    replacements.playerId = opts.playerId;
  }

  return {sql: parts.join(' AND '), replacements};
}

async function fetchMismatchBatch(
  opts: CliOptions,
  afterId: number,
  extraWhere: string,
): Promise<MismatchPassRow[]> {
  const {sql: passFilters, replacements: filterRep} = buildPassFilters(opts);
  const rows = (await passesSequelize.query(
    `
    /* Cast BIGINT UNSIGNED columns to DECIMAL to avoid overflow when summing. */
    SELECT p.id, p.levelId, p.playerId, p.accuracy AS passAccuracy,
           l.tilecount,
           j.earlyDouble, j.earlySingle, j.ePerfect, j.perfect, j.lPerfect,
           j.lateSingle, j.lateDouble, j.accuracy AS judgementAccuracy,
           (
             CAST(j.earlyDouble AS DECIMAL(65,0)) +
             CAST(j.earlySingle AS DECIMAL(65,0)) +
             CAST(j.ePerfect AS DECIMAL(65,0)) +
             CAST(j.perfect AS DECIMAL(65,0)) +
             CAST(j.lPerfect AS DECIMAL(65,0)) +
             CAST(j.lateSingle AS DECIMAL(65,0)) +
             CAST(j.lateDouble AS DECIMAL(65,0))
           ) AS totalHits
    FROM passes p
    INNER JOIN judgements j ON j.id = p.id
    INNER JOIN levels l ON l.id = p.levelId
    WHERE p.id > :afterId
      AND IFNULL(l.isDeleted, 0) = 0
      AND l.tilecount IS NOT NULL AND l.tilecount > 0
      AND ABS(
        (
          CAST(j.earlyDouble AS DECIMAL(65,0)) +
          CAST(j.earlySingle AS DECIMAL(65,0)) +
          CAST(j.ePerfect AS DECIMAL(65,0)) +
          CAST(j.perfect AS DECIMAL(65,0)) +
          CAST(j.lPerfect AS DECIMAL(65,0)) +
          CAST(j.lateSingle AS DECIMAL(65,0)) +
          CAST(j.lateDouble AS DECIMAL(65,0))
        ) - CAST(l.tilecount AS DECIMAL(65,0))
      ) > :margin
      AND ${passFilters}
      ${extraWhere ? `AND (${extraWhere})` : ''}
    ORDER BY p.id ASC
    LIMIT :limit
    `,
    {
      replacements: {
        ...filterRep,
        afterId,
        margin: opts.margin,
        limit: opts.limit,
      },
      type: QueryTypes.SELECT,
    },
  )) as MismatchPassRow[];
  return rows;
}

async function runScan(opts: CliOptions): Promise<void> {
  let afterId = opts.afterId;
  let scannedBatches = 0;
  let totalMismatch = 0;
  let perfectsOnlyMismatch = 0;
  let mixedMismatch = 0;
  const scanRows: Array<Record<string, unknown>> = [];

  const csvHeader =
    'passId,levelId,playerId,tilecount,totalHits,delta,mismatchType,judgementAccuracy,passAccuracy\n';

  for (;;) {
    const batch = await fetchMismatchBatch(opts, afterId, '');
    if (batch.length === 0) break;
    scannedBatches++;

    for (const row of batch) {
      const totalHits = num(row.totalHits);
      const tilecount = num(row.tilecount);
      const delta = totalHits - tilecount;
      const jAcc =
        row.judgementAccuracy == null
          ? null
          : num(row.judgementAccuracy);
      const perfectOnly = isPerfectsOnlyJudgementAccuracy(jAcc);
      const mismatchType = perfectOnly ? 'perfects_only' : 'mixed';

      totalMismatch++;
      if (perfectOnly) perfectsOnlyMismatch++;
      else mixedMismatch++;

      scanRows.push({
        passId: row.id,
        levelId: row.levelId,
        playerId: row.playerId,
        tilecount,
        totalHits,
        delta,
        mismatchType,
        judgementAccuracy: jAcc,
        passAccuracy: row.passAccuracy == null ? null : num(row.passAccuracy),
      });
    }

    afterId = batch[batch.length - 1].id;
    if (batch.length < opts.limit) break;
  }

  logger.info('Scan summary', {
    scannedBatches,
    totalMismatch,
    perfectsOnlyMismatch,
    mixedMismatch,
    margin: opts.margin,
  });

  if (opts.outCsv) {
    let out = csvHeader;
    for (const r of scanRows) {
      out += rowToCsvLine([
        String(r.passId),
        String(r.levelId),
        String(r.playerId),
        String(r.tilecount),
        String(r.totalHits),
        String(r.delta),
        String(r.mismatchType),
        r.judgementAccuracy == null ? '' : String(r.judgementAccuracy),
        r.passAccuracy == null ? '' : String(r.passAccuracy),
      ]);
    }
    await writeFile(opts.outCsv, out, 'utf8');
    logger.info('Wrote CSV', {path: opts.outCsv});
  }
  if (opts.outJson) {
    await writeFile(opts.outJson, JSON.stringify(scanRows, null, 2), 'utf8');
    logger.info('Wrote JSON', {path: opts.outJson});
  }
}

async function runClamp(opts: CliOptions): Promise<void> {
  const dryRun = !opts.apply;
  let afterId = opts.afterId;
  let totalCandidates = 0;
  let clamped = 0;
  let errors = 0;

  const extraWhere = 'j.accuracy IS NOT NULL AND ABS(j.accuracy - 1) < 1e-9';

  for (;;) {
    const batch = await fetchMismatchBatch(opts, afterId, extraWhere);
    if (batch.length === 0) break;

    totalCandidates += batch.length;

    for (let i = 0; i < batch.length; i += opts.batchSize) {
      const chunk = batch.slice(i, i + opts.batchSize);

      if (dryRun) {
        for (const row of chunk) {
          logger.info('[DRY RUN] would clamp pass', {
            passId: row.id,
            levelId: row.levelId,
            tilecount: num(row.tilecount),
            totalHits: num(row.totalHits),
            perfectBefore: num(row.perfect),
          });
          clamped++;
        }
        continue;
      }

      let transaction: Transaction | undefined;
      try {
        transaction = await passesSequelize.transaction();
        for (const row of chunk) {
          const tilecountVal = num(row.tilecount);
          const cleared: IJudgements = {
            earlyDouble: 0,
            earlySingle: 0,
            ePerfect: 0,
            perfect: tilecountVal,
            lPerfect: 0,
            lateSingle: 0,
            lateDouble: 0,
          };

          await Judgement.update(cleared, {
            where: {id: row.id},
            transaction,
          });

          const pass = await Pass.findByPk(row.id, {
            transaction,
            include: [
              {
                model: Level,
                as: 'level',
                required: true,
                include: [
                  {
                    model: Difficulty,
                    as: 'difficulty',
                    required: true,
                  },
                ],
              },
            ],
          });

          if (!pass?.level?.difficulty) {
            logger.error('Pass missing level/difficulty, skipping update', {passId: row.id});
            errors++;
            continue;
          }

          const newAcc = calcAcc(cleared);
          const levelData = {
            baseScore: pass.level.baseScore,
            ppBaseScore: pass.level.ppBaseScore,
            difficulty: {
              name: pass.level.difficulty.name,
              baseScore: pass.level.difficulty.baseScore,
            },
          };
          const newScore = getScoreV2(
            {
              speed: pass.speed ?? 1,
              judgements: cleared,
              isNoHoldTap: pass.isNoHoldTap ?? false,
            },
            levelData,
          );

          await pass.update(
            {accuracy: newAcc, scoreV2: newScore},
            {transaction},
          );
          clamped++;
          logger.info('Clamped pass', {
            passId: row.id,
            tilecount: tilecountVal,
            scoreV2: newScore,
          });
        }
        await transaction.commit();
      } catch (e) {
        await safeTransactionRollback(transaction);
        logger.error('Batch failed, rolled back', {
          error: e instanceof Error ? e.message : String(e),
        });
        errors++;
        throw e;
      }
    }

    afterId = batch[batch.length - 1].id;
    if (batch.length < opts.limit) break;
  }

  logger.info('Clamp summary', {
    dryRun,
    totalCandidates,
    clamped,
    errors,
  });
}

async function runFlagLevels(opts: CliOptions): Promise<void> {
  const {sql: passFilters, replacements: filterRep} = buildPassFilters(opts);

  const rows = (await passesSequelize.query(
    `
    SELECT
      l.id AS levelId,
      l.song,
      l.artist,
      l.tilecount,
      COUNT(*) AS nonPerfectPasses,
      SUM(CASE WHEN ABS(t.totalHits - CAST(l.tilecount AS DECIMAL(65,0))) > :margin THEN 1 ELSE 0 END) AS mismatched,
      MIN(t.totalHits) AS minHits,
      MAX(t.totalHits) AS maxHits,
      AVG(t.totalHits) AS avgHits
    FROM (
      SELECT
        p.levelId,
        (
          CAST(j.earlyDouble AS DECIMAL(65,0)) +
          CAST(j.earlySingle AS DECIMAL(65,0)) +
          CAST(j.ePerfect AS DECIMAL(65,0)) +
          CAST(j.perfect AS DECIMAL(65,0)) +
          CAST(j.lPerfect AS DECIMAL(65,0)) +
          CAST(j.lateSingle AS DECIMAL(65,0)) +
          CAST(j.lateDouble AS DECIMAL(65,0))
        ) AS totalHits,
        j.accuracy AS judgementAccuracy
      FROM passes p
      INNER JOIN judgements j ON j.id = p.id
      WHERE ${passFilters}
        AND (j.accuracy IS NULL OR ABS(j.accuracy - 1) >= 1e-9)
    ) t
    INNER JOIN levels l ON l.id = t.levelId AND IFNULL(l.isDeleted, 0) = 0
    WHERE l.tilecount IS NOT NULL AND l.tilecount > 0
    GROUP BY l.id, l.song, l.artist, l.tilecount
    HAVING COUNT(*) >= :minPasses
      AND (
        SUM(CASE WHEN ABS(t.totalHits - CAST(l.tilecount AS DECIMAL(65,0))) > :margin THEN 1 ELSE 0 END) / COUNT(*)
      ) >= :threshold
    ORDER BY l.id ASC
    `,
    {
      replacements: {
        ...filterRep,
        margin: opts.margin,
        minPasses: opts.minPasses,
        threshold: opts.levelFlagThreshold,
      },
      type: QueryTypes.SELECT,
    },
  )) as Array<{
    levelId: number;
    song: string | null;
    artist: string | null;
    tilecount: number;
    nonPerfectPasses: string | number;
    mismatched: string | number;
    minHits: string | number;
    maxHits: string | number;
    avgHits: string | number;
  }>;

  const flagged: FlaggedLevelRow[] = rows.map((r) => {
    const npc = num(r.nonPerfectPasses);
    const mis = num(r.mismatched);
    return {
      levelId: r.levelId,
      song: r.song,
      artist: r.artist,
      tilecount: num(r.tilecount),
      nonPerfectPasses: npc,
      mismatched: mis,
      mismatchRate: npc > 0 ? mis / npc : 0,
      minHits: num(r.minHits),
      maxHits: num(r.maxHits),
      avgHits: num(r.avgHits),
    };
  });

  logger.info('Flag-levels summary', {
    flaggedCount: flagged.length,
    threshold: opts.levelFlagThreshold,
    minPasses: opts.minPasses,
    margin: opts.margin,
  });

  if (opts.outCsv) {
    const header =
      'levelId,song,artist,tilecount,nonPerfectPasses,mismatched,mismatchRate,minHits,maxHits,avgHits\n';
    let out = header;
    for (const r of flagged) {
      out += rowToCsvLine([
        String(r.levelId),
        r.song ?? '',
        r.artist ?? '',
        String(r.tilecount),
        String(r.nonPerfectPasses),
        String(r.mismatched),
        String(r.mismatchRate),
        String(r.minHits),
        String(r.maxHits),
        String(r.avgHits),
      ]);
    }
    await writeFile(opts.outCsv, out, 'utf8');
    logger.info('Wrote CSV', {path: opts.outCsv});
  }
  if (opts.outJson) {
    await writeFile(opts.outJson, JSON.stringify(flagged, null, 2), 'utf8');
    logger.info('Wrote JSON', {path: opts.outJson});
  }
  if (!opts.outCsv && !opts.outJson && flagged.length > 0) {
    console.log(JSON.stringify(flagged, null, 2));
  }
}

function parseMode(s: string): Mode {
  if (s === 'scan' || s === 'clamp' || s === 'flag-levels') return s;
  throw new Error(`Invalid --mode "${s}" (use scan | clamp | flag-levels)`);
}

function printHelp(): void {
  const text = `
auditPassJudgements.ts

Audits pass judgement totals vs levels.tilecount, optionally repairs inflated perfect-only passes,
and can flag levels that appear to have the wrong chart selected (tilecount mismatch patterns).

The script operates on:
- passes (p)
- judgements (j) (7 buckets)
- levels (l) (tilecount)

Judgement buckets:
  earlyDouble, earlySingle, ePerfect, perfect, lPerfect, lateSingle, lateDouble

totalHits = sum(all 7 buckets)
tilecount = levels.tilecount
mismatch when |totalHits - tilecount| > margin

Perfects-only definition:
  Uses judgement accuracy as computed by DB trigger:
    j.accuracy ≈ 1
  This corresponds to only 'perfect' having value (all other buckets 0) under the weighting formula.

USAGE (from server/):
  npx tsx src/misc/scripts/auditPassJudgements.ts --help
  npm run audit-pass-judgements -- --help

MODES (--mode, default: scan)
  --mode scan
    Read-only. Lists mismatched passes and categorizes them:
      - perfects_only (j.accuracy ≈ 1)
      - mixed        (everything else)
    Outputs a summary to logger and can export CSV/JSON.

  --mode clamp
    Repairs ONLY perfects-only mismatched passes.
    For each candidate pass it sets:
      earlyDouble=0, earlySingle=0, ePerfect=0, lPerfect=0, lateSingle=0, lateDouble=0
      perfect = levels.tilecount
    Then recalculates and persists:
      passes.accuracy, passes.scoreV2

    Safety:
      By default this is DRY-RUN. It will log what it would change.
      To actually write changes you must pass: --apply

  --mode flag-levels
    Read-only. Looks for levels where NON perfects-only passes disagree with tilecount.
    This helps detect \"wrong level selected\" situations (e.g. a pack chart selected instead of a single level).

    It flags a level when:
      nonPerfectPasses >= --min-passes
      mismatchRate     >= --level-flag-threshold

FLAGS
  --mode <scan|clamp|flag-levels>
    Select operation mode. Default: scan

  --margin <int>
    Allowed absolute difference between totalHits and tilecount before it counts as mismatch.
    Default: 0

  --level-id <int>
    Only consider passes for one levelId.

  --player-id <int>
    Only consider passes for one playerId.

  --after-id <int>
    Only scan passes with p.id > after-id. Useful for resuming. Default: 0

  --limit <int>
    Page size for scan/clamp mismatch fetch. Default: 1000

  --batch-size <int>
    In clamp mode (when --apply is set), DB writes are committed in chunks of this size.
    Default: 1000

  --include-deleted
    Include passes where p.isDeleted = 1. Default: false

  --include-hidden
    Include passes where p.isHidden = 1. Default: false

  --apply
    Clamp mode only. Actually writes changes. Default: false

  --level-flag-threshold <0..1>
    Flag-levels mode only. Required mismatchRate (fraction). Default: 1
      1.0 means \"all\" non-perfect passes mismatch.
      0.8 means \"80%\" mismatch.

  --min-passes <int>
    Flag-levels mode only. Minimum number of non-perfect passes required. Default: 1

  --out-csv <path>
    Write results to CSV (scan or flag-levels). Optional.

  --out-json <path>
    Write results to JSON (scan or flag-levels). Optional.

EXAMPLES
  Scan mismatches (export CSV):
    npx tsx src/misc/scripts/auditPassJudgements.ts --mode scan --margin 0 --out-csv ./mismatches.csv

  Clamp perfects-only mismatches (dry-run):
    npx tsx src/misc/scripts/auditPassJudgements.ts --mode clamp --margin 0

  Clamp perfects-only mismatches (apply changes):
    npx tsx src/misc/scripts/auditPassJudgements.ts --mode clamp --margin 0 --apply

  Flag suspicious levels using 80% mismatch threshold, at least 3 non-perfect passes:
    npx tsx src/misc/scripts/auditPassJudgements.ts --mode flag-levels --level-flag-threshold 0.8 --min-passes 3 --out-json ./suspect-levels.json

NOTES
  - SQL uses DECIMAL casts to safely handle extreme BIGINT UNSIGNED judgement values.
  - Levels with tilecount NULL/0 are ignored.
`.trim();

  console.log(text);
}

async function runScript() {
  const {values} = parseArgs({
    options: {
      help: {type: 'boolean', short: 'h', default: false},
      mode: {type: 'string', default: 'scan'},
      margin: {type: 'string', default: '0'},
      'level-id': {type: 'string'},
      'player-id': {type: 'string'},
      'after-id': {type: 'string', default: '0'},
      limit: {type: 'string', default: '1000'},
      'batch-size': {type: 'string', default: '1000'},
      'include-deleted': {type: 'boolean', default: false},
      'include-hidden': {type: 'boolean', default: false},
      apply: {type: 'boolean', default: false},
      'level-flag-threshold': {type: 'string', default: '1'},
      'min-passes': {type: 'string', default: '1'},
      'out-csv': {type: 'string'},
      'out-json': {type: 'string'},
    },
    allowPositionals: false,
  });

  if (values.help) {
    printHelp();
    return;
  }

  const margin = parseInt(String(values.margin), 10);
  if (!Number.isFinite(margin) || margin < 0) {
    throw new Error('Invalid --margin (non-negative integer)');
  }

  const levelIdRaw = values['level-id'];
  const levelId =
    levelIdRaw != null && levelIdRaw !== ''
      ? parseInt(String(levelIdRaw), 10)
      : undefined;
  if (levelId != null && (!Number.isFinite(levelId) || levelId <= 0)) {
    throw new Error('Invalid --level-id');
  }

  const playerIdRaw = values['player-id'];
  const playerId =
    playerIdRaw != null && playerIdRaw !== ''
      ? parseInt(String(playerIdRaw), 10)
      : undefined;
  if (playerId != null && (!Number.isFinite(playerId) || playerId <= 0)) {
    throw new Error('Invalid --player-id');
  }

  const afterId = parseInt(String(values['after-id']), 10);
  if (!Number.isFinite(afterId) || afterId < 0) {
    throw new Error('Invalid --after-id');
  }

  const limit = parseInt(String(values.limit), 10);
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error('Invalid --limit');
  }

  const batchSize = parseInt(String(values['batch-size']), 10);
  if (!Number.isFinite(batchSize) || batchSize < 1) {
    throw new Error('Invalid --batch-size');
  }

  const levelFlagThreshold = parseFloat(String(values['level-flag-threshold']));
  if (
    !Number.isFinite(levelFlagThreshold) ||
    levelFlagThreshold < 0 ||
    levelFlagThreshold > 1
  ) {
    throw new Error('Invalid --level-flag-threshold (0..1)');
  }

  const minPasses = parseInt(String(values['min-passes']), 10);
  if (!Number.isFinite(minPasses) || minPasses < 1) {
    throw new Error('Invalid --min-passes');
  }

  const opts: CliOptions = {
    mode: parseMode(String(values.mode)),
    margin,
    levelId:
      levelId !== undefined && Number.isFinite(levelId) ? levelId : undefined,
    playerId:
      playerId !== undefined && Number.isFinite(playerId)
        ? playerId
        : undefined,
    afterId,
    limit,
    batchSize,
    includeDeleted: Boolean(values['include-deleted']),
    includeHidden: Boolean(values['include-hidden']),
    apply: Boolean(values.apply),
    levelFlagThreshold,
    minPasses,
    outCsv: values['out-csv']?.trim() || undefined,
    outJson: values['out-json']?.trim() || undefined,
  };

  const t0 = Date.now();
  await passesSequelize.authenticate();
  logger.info('DB OK', {mode: opts.mode});

  if (opts.mode === 'scan') {
    await runScan(opts);
  } else if (opts.mode === 'clamp') {
    await runClamp(opts);
  } else {
    await runFlagLevels(opts);
  }

  logger.info('Done', {elapsedMs: Date.now() - t0});
}

runScript()
  .catch((e) => {
    logger.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await passesSequelize.close();
  })
  .then(() => {
    process.exit(process.exitCode ?? 0);
  });
