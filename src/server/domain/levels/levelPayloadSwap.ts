import { Transaction } from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';
import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';

const levelsSequelize = getSequelizeForModelGroup('levels');

/** Columns exchanged between two level rows (ids stay fixed). */
export const LEVEL_PAYLOAD_SWAP_FIELDS = [
  'song',
  'artist',
  'songId',
  'suffix',
  'diffId',
  'baseScore',
  'ppBaseScore',
  'previousBaseScore',
  'videoLink',
  'dlLink',
  'fileId',
  'legacyDllink',
  'workshopLink',
  'publicComments',
  'toRate',
  'rerateReason',
  'rerateNum',
  'previousDiffId',
  'isAnnounced',
  'isHidden',
  'isExternallyAvailable',
  'teamId',
  'bpm',
  'tilecount',
  'autoTileCount',
  'levelLengthInMs',
  'xaccCurveMeta',
] as const;

/**
 * Child tables whose `levelId` is remapped A↔B after the payload exchange.
 * `level_likes` is intentionally excluded (unique mid-update collisions).
 * Table names are a fixed allowlist for raw SQL.
 */
const LEVEL_ID_REMAP_TABLES = [
  'passes',
  'pass_submissions',
  'ratings',
  'level_credits',
  'level_pack_items',
  'level_aliases',
  'level_tag_assignments',
  '`references`',
  'curations',
  'level_rerate_histories',
  'level_announcement_queue',
  'directive_condition_history',
  'tournament_placements',
] as const;

export type LevelPayloadSwapErrorCode =
  | 'INVALID_IDS'
  | 'SAME_LEVEL'
  | 'NOT_FOUND';

export class LevelPayloadSwapError extends Error {
  constructor(
    public readonly code: LevelPayloadSwapErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LevelPayloadSwapError';
  }
}

function pickLevelPayloadSwapFields(level: Level): Record<string, unknown> {
  const plain = level.get({ plain: true }) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of LEVEL_PAYLOAD_SWAP_FIELDS) {
    out[field] = plain[field];
  }
  return out;
}

async function setForeignKeyChecks(
  enabled: boolean,
  transaction: Transaction,
): Promise<void> {
  await levelsSequelize.query(`SET FOREIGN_KEY_CHECKS = ${enabled ? 1 : 0}`, {
    transaction,
  });
}

/**
 * Two-phase levelId remap via negative temps so composite uniques cannot collide mid-update.
 */
async function remapLevelIdColumn(
  tableSql: string,
  column: string,
  a: number,
  b: number,
  transaction: Transaction,
): Promise<void> {
  const replacements = { a, b, negA: -a, negB: -b };
  await levelsSequelize.query(
    `
    UPDATE ${tableSql}
    SET \`${column}\` = CASE
      WHEN \`${column}\` = :a THEN :negA
      WHEN \`${column}\` = :b THEN :negB
      ELSE \`${column}\`
    END
    WHERE \`${column}\` IN (:a, :b)
    `,
    { replacements, transaction },
  );
  await levelsSequelize.query(
    `
    UPDATE ${tableSql}
    SET \`${column}\` = CASE
      WHEN \`${column}\` = :negA THEN :b
      WHEN \`${column}\` = :negB THEN :a
      ELSE \`${column}\`
    END
    WHERE \`${column}\` IN (:negA, :negB)
    `,
    { replacements, transaction },
  );
}

async function remapChildLevelIds(
  a: number,
  b: number,
  transaction: Transaction,
): Promise<void> {
  await setForeignKeyChecks(false, transaction);
  try {
    for (const tableSql of LEVEL_ID_REMAP_TABLES) {
      await remapLevelIdColumn(tableSql, 'levelId', a, b, transaction);
    }
    // pendingUniqueKey mirrors levelId while PENDING (unique); keep it aligned.
    await remapLevelIdColumn(
      'level_announcement_queue',
      'pendingUniqueKey',
      a,
      b,
      transaction,
    );
  } finally {
    await setForeignKeyChecks(true, transaction);
  }
}

async function recalculateClearCounts(
  a: number,
  b: number,
  transaction: Transaction,
): Promise<void> {
  await levelsSequelize.query('CALL recalculate_level_clear_count(:levelId)', {
    replacements: { levelId: a },
    transaction,
  });
  await levelsSequelize.query('CALL recalculate_level_clear_count(:levelId)', {
    replacements: { levelId: b },
    transaction,
  });
}

export type LevelPayloadSwapResult = {
  levelA: Record<string, unknown> | null;
  levelB: Record<string, unknown> | null;
  sourceId: number;
  targetId: number;
};

/**
 * Swap chart/metadata columns between two levels, then remap child levelIds
 * (except likes) so linked rows follow the chart content. IDs stay fixed.
 */
export async function executeLevelPayloadSwap(
  sourceId: number,
  targetId: number,
): Promise<LevelPayloadSwapResult> {
  if (
    !Number.isInteger(sourceId) ||
    sourceId <= 0 ||
    !Number.isInteger(targetId) ||
    targetId <= 0
  ) {
    throw new LevelPayloadSwapError('INVALID_IDS', 'Invalid level id(s)');
  }
  if (sourceId === targetId) {
    throw new LevelPayloadSwapError('SAME_LEVEL', 'Cannot swap a level with itself');
  }

  const transaction = await levelsSequelize.transaction({
    isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ,
  });

  try {
    const [lowId, highId] =
      sourceId < targetId ? [sourceId, targetId] : [targetId, sourceId];

    const low = await Level.findByPk(lowId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const high = await Level.findByPk(highId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!low || !high) {
      await transaction.rollback();
      throw new LevelPayloadSwapError('NOT_FOUND', 'One or both levels not found');
    }

    const source = sourceId === lowId ? low : high;
    const target = targetId === lowId ? low : high;

    const sourcePayload = pickLevelPayloadSwapFields(source);
    const targetPayload = pickLevelPayloadSwapFields(target);
    const now = new Date();

    await source.update({ ...targetPayload, updatedAt: now } as any, { transaction });
    await target.update({ ...sourcePayload, updatedAt: now } as any, { transaction });

    await remapChildLevelIds(sourceId, targetId, transaction);
    await recalculateClearCounts(sourceId, targetId, transaction);

    await transaction.commit();
  } catch (error) {
    if (!(error instanceof LevelPayloadSwapError)) {
      try {
        await transaction.rollback();
      } catch {
        // already finished / rolled back
      }
    }
    throw error;
  }

  const difficultyInclude = [
    { model: Difficulty, as: 'difficulty', required: false },
    { model: Difficulty, as: 'previousDifficulty', required: false },
  ];

  const [levelA, levelB] = await Promise.all([
    Level.findByPk(sourceId, { include: difficultyInclude }),
    Level.findByPk(targetId, { include: difficultyInclude }),
  ]);

  return {
    sourceId,
    targetId,
    levelA: (levelA?.get({ plain: true }) as unknown as Record<string, unknown>) ?? null,
    levelB: (levelB?.get({ plain: true }) as unknown as Record<string, unknown>) ?? null,
  };
}
