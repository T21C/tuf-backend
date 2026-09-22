/**
 * Move world's first and world's first PP onto the earliest non-deleted 1.0x clear.
 *
 * Only levels whose current flag holder is missing a speed or is not exactly 1.0x
 * are touched. A holder that is already 1.0x was the earliest clear overall, so it
 * is still the earliest 1.0x.
 *
 * Usage (from server/):
 *   npx tsx src/misc/scripts/backfillWorldsFirstFlags.ts
 *   npx tsx src/misc/scripts/backfillWorldsFirstFlags.ts --apply
 *   npx tsx src/misc/scripts/backfillWorldsFirstFlags.ts --level-id 123 --apply
 *   npx tsx src/misc/scripts/backfillWorldsFirstFlags.ts --after-level-id 1000 --limit 200 --apply
 *   npx tsx src/misc/scripts/backfillWorldsFirstFlags.ts --apply --skip-reindex
 */

import {parseArgs} from 'node:util';
import dotenv from 'dotenv';
import {Op, QueryTypes} from 'sequelize';

dotenv.config();

import {getSequelizeForModelGroup} from '@/config/db.js';
import {initializeAssociations} from '@/models/associations.js';
import Pass from '@/models/passes/Pass.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {updateWorldsFirstFlags} from '@/server/services/passes/worldsFirst.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';

initializeAssociations();

const passesSequelize = getSequelizeForModelGroup('passes');

/** Must match WORLDS_FIRST_SPEED in worldsFirst.ts. */
const WORLDS_FIRST_SPEED = 1;

interface CliOptions {
  apply: boolean;
  skipReindex: boolean;
  levelId?: number;
  afterLevelId: number;
  limit?: number;
}

interface LevelRow {
  levelId: number;
}

interface HolderRow {
  id: number;
  playerId: number;
  speed: number | null;
  isWorldsFirst: boolean | number | null;
  isWorldsFirstPP: boolean | number | null;
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
      'level-id': {type: 'string'},
      'after-level-id': {type: 'string'},
      limit: {type: 'string'},
    },
    allowPositionals: false,
  });

  const afterLevelId = parsePositiveInt(values['after-level-id'], '--after-level-id') ?? 0;

  return {
    apply: values.apply ?? false,
    skipReindex: values['skip-reindex'] ?? false,
    levelId: parsePositiveInt(values['level-id'], '--level-id'),
    afterLevelId,
    limit: parsePositiveInt(values.limit, '--limit'),
  };
}

async function findLevelIds(opts: CliOptions): Promise<number[]> {
  const replacements: Record<string, number> = {speed: WORLDS_FIRST_SPEED};
  const filters = [
    '(isWorldsFirst = 1 OR isWorldsFirstPP = 1)',
    '(speed IS NULL OR speed <> :speed)',
  ];

  if (opts.levelId != null) {
    filters.push('levelId = :levelId');
    replacements.levelId = opts.levelId;
  }
  if (opts.afterLevelId > 0) {
    filters.push('levelId > :afterLevelId');
    replacements.afterLevelId = opts.afterLevelId;
  }

  const limitSql = opts.limit != null ? `LIMIT ${opts.limit}` : '';
  const rows = await passesSequelize.query<LevelRow>(
    `SELECT DISTINCT levelId
     FROM passes
     WHERE ${filters.join(' AND ')}
     ORDER BY levelId ASC
     ${limitSql}`,
    {replacements, type: QueryTypes.SELECT},
  );

  return rows.map((row) => Number(row.levelId));
}

async function currentHolders(levelId: number): Promise<HolderRow[]> {
  return Pass.findAll({
    where: {
      levelId,
      [Op.or]: [{isWorldsFirst: true}, {isWorldsFirstPP: true}],
    },
    attributes: ['id', 'playerId', 'speed', 'isWorldsFirst', 'isWorldsFirstPP'],
    raw: true,
  }) as unknown as HolderRow[];
}

function flagOn(value: boolean | number | null | undefined): boolean {
  return value === true || value === 1;
}

function describeHolder(row: HolderRow | undefined, kind: 'clear' | 'pp'): string {
  if (!row) return `${kind}=none`;
  const speed = row.speed == null ? 'null' : `${row.speed}x`;
  return `${kind}=${row.id} player=${row.playerId} speed=${speed}`;
}

function holderFor(rows: HolderRow[], kind: 'clear' | 'pp'): HolderRow | undefined {
  return rows.find((row) => flagOn(kind === 'clear' ? row.isWorldsFirst : row.isWorldsFirstPP));
}

async function earliestQualifying(levelId: number, perfect: boolean): Promise<HolderRow | null> {
  const row = await Pass.findOne({
    where: {
      levelId,
      isDeleted: false,
      speed: WORLDS_FIRST_SPEED,
      ...(perfect ? {accuracy: 1} : {}),
    },
    attributes: ['id', 'playerId', 'speed', 'isWorldsFirst', 'isWorldsFirstPP'],
    order: [['vidUploadTime', 'ASC']],
    raw: true,
  });
  return (row as HolderRow | null) ?? null;
}

async function main(): Promise<void> {
  const opts = parseCli();
  await passesSequelize.authenticate();

  const levelIds = await findLevelIds(opts);
  logger.info('World\'s first 1.0x backfill', {
    apply: opts.apply,
    skipReindex: opts.skipReindex,
    levels: levelIds.length,
    levelId: opts.levelId,
    afterLevelId: opts.afterLevelId || undefined,
    limit: opts.limit,
  });

  const passIds = new Set<number>();
  const playerIds = new Set<number>();
  let updated = 0;
  let failed = 0;

  for (const levelId of levelIds) {
    const before = await currentHolders(levelId);
    const beforeClear = holderFor(before, 'clear');
    const beforePp = holderFor(before, 'pp');

    if (!opts.apply) {
      const nextClear = await earliestQualifying(levelId, false);
      const nextPp = await earliestQualifying(levelId, true);
      logger.info(
        `level ${levelId}: ${describeHolder(beforeClear, 'clear')} -> ${describeHolder(nextClear ?? undefined, 'clear')}; ${describeHolder(beforePp, 'pp')} -> ${describeHolder(nextPp ?? undefined, 'pp')}`,
      );
      continue;
    }

    const transaction = await passesSequelize.transaction();
    try {
      await updateWorldsFirstFlags(levelId, transaction);
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      failed++;
      logger.error(`level ${levelId} failed`, {error});
      continue;
    }

    const after = await currentHolders(levelId);
    for (const row of [...before, ...after]) {
      passIds.add(row.id);
      if (row.playerId) playerIds.add(row.playerId);
    }
    updated++;
    logger.info(
      `level ${levelId}: ${describeHolder(beforeClear, 'clear')} -> ${describeHolder(holderFor(after, 'clear'), 'clear')}; ${describeHolder(beforePp, 'pp')} -> ${describeHolder(holderFor(after, 'pp'), 'pp')}`,
    );
  }

  if (!opts.apply) {
    logger.info(`Dry-run only — ${levelIds.length} level(s). Pass --apply to write changes`);
    return;
  }

  logger.info('Backfill writes done', {updated, failed, passes: passIds.size, players: playerIds.size});

  if (!opts.skipReindex && passIds.size > 0) {
    const elasticsearchService = ElasticsearchService.getInstance();
    logger.info(`Reindexing ${passIds.size} pass(es)`);
    await elasticsearchService.reindexPasses([...passIds]);
    if (playerIds.size > 0) {
      logger.info(`Reindexing ${playerIds.size} player(s)`);
      await elasticsearchService.reindexPlayers([...playerIds]);
    }
  }

  if (failed > 0) {
    throw new Error(`${failed} level(s) failed`);
  }
}

main()
  .then(async () => {
    await passesSequelize.close();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error('backfillWorldsFirstFlags failed', {error: err});
    console.error(err);
    await passesSequelize.close().catch(() => {});
    process.exit(1);
  });
