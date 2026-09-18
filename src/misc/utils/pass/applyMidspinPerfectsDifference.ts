import {Transaction} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import Pass from '@/models/passes/Pass.js';
import Judgement from '@/models/passes/Judgement.js';
import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';
import {cloneJudgements} from './CalcAcc.js';
import {buildLevelScoreContext, computePassScoreV2} from './scoreService.js';
import {updateWorldsFirstPPStatus} from '@/server/services/passes/worldsFirst.js';
import {
  applyPerfectsDelta,
  perfectsDeltaFromMidspinChange,
} from './midspinPerfectDecrement.js';
import {logger} from '@/server/services/core/LoggerService.js';

export type MidspinPerfectsDifferenceResult = {
  playerIds: number[];
  passIds: number[];
  updatedCount: number;
  skippedCount: number;
  delta: number;
};

function emptyResult(delta: number): MidspinPerfectsDifferenceResult {
  return {playerIds: [], passIds: [], updatedCount: 0, skippedCount: 0, delta};
}

/**
 * Add `oldMidspin - newMidspin` to Perfect on every pass of the level, then
 * recompute accuracy/score. Skips rows that would go below 0.
 */
export async function applyMidspinPerfectsDifferenceToLevelPasses(params: {
  levelId: number;
  oldMidspinCount: number | null;
  newMidspinCount: number | null;
}): Promise<MidspinPerfectsDifferenceResult> {
  const delta = perfectsDeltaFromMidspinChange(
    params.oldMidspinCount,
    params.newMidspinCount,
  );
  if (delta === 0) {
    return emptyResult(0);
  }

  const levelRow = await Level.findByPk(params.levelId, {
    attributes: ['id', 'baseScore', 'ppBaseScore', 'xaccCurveMeta', 'diffId'],
  });
  if (!levelRow) {
    return emptyResult(delta);
  }

  const currentDifficulty = await Difficulty.findByPk(levelRow.diffId);
  if (!currentDifficulty) {
    logger.error(
      `No difficulty found for level ${params.levelId} with diffId ${levelRow.diffId}`,
    );
    return emptyResult(delta);
  }

  const levelContext = buildLevelScoreContext(levelRow, {
    difficulty: {
      name: currentDifficulty.name,
      baseScore: currentDifficulty.baseScore || 0,
    },
  });

  const passesSequelize = getSequelizeForModelGroup('passes');
  let transaction: Transaction | null = null;
  try {
    transaction = await passesSequelize.transaction({
      isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED,
    });

    const passes = await Pass.findAll({
      where: {levelId: params.levelId},
      include: [{model: Judgement, as: 'judgements', required: true}],
      transaction,
    });

    const passIds: number[] = [];
    const playerIds: number[] = [];
    let skippedCount = 0;

    for (const pass of passes) {
      const judgementsRow = pass.judgements;
      if (!judgementsRow) {
        skippedCount++;
        continue;
      }

      const judgements = cloneJudgements(judgementsRow);
      const applied = applyPerfectsDelta(judgements.perfect, delta);
      if (!applied.applied) {
        skippedCount++;
        continue;
      }
      judgements.perfect = applied.perfect;

      const {accuracy, scoreV2} = computePassScoreV2(
        {
          speed: pass.speed || 1,
          judgements,
          isNoHoldTap: pass.isNoHoldTap || false,
        },
        levelContext,
      );

      await judgementsRow.update(
        {perfect: judgements.perfect, accuracy},
        {transaction},
      );
      await pass.update({accuracy, scoreV2}, {transaction});
      passIds.push(pass.id);
      if (pass.playerId) {
        playerIds.push(pass.playerId);
      }
    }

    if (passIds.length > 0) {
      await updateWorldsFirstPPStatus(params.levelId, transaction);
    }

    await transaction.commit();
    transaction = null;

    logger.info(
      `Applied midspin Perfects difference ${delta} on level ${params.levelId}: ` +
        `${passIds.length} updated, ${skippedCount} skipped`,
    );

    return {
      playerIds,
      passIds,
      updatedCount: passIds.length,
      skippedCount,
      delta,
    };
  } catch (error) {
    if (transaction) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        logger.error(
          'Error rolling back midspin Perfects difference apply:',
          rollbackErr,
        );
      }
    }
    throw error;
  }
}
