import {Op, type Transaction} from 'sequelize';
import Pass from '@/models/passes/Pass.js';
import Judgement from '@/models/passes/Judgement.js';
import {isWrongJudgement} from './CalcAcc.js';

export function isWrongJudgementFromChart(
  judgements: unknown,
  chart: {tilecount?: unknown; autoTileCount?: unknown} | null | undefined,
): boolean {
  return isWrongJudgement(judgements, {
    tilecount: chart?.tilecount,
    autoTileCount: chart?.autoTileCount,
  });
}

/**
 * Recompute `passes.isWrongJudgement` for every pass on a level.
 * Returns pass ids whose flag actually changed (for ES reindex).
 */
export async function syncWrongJudgementFlagsForLevel(params: {
  levelId: number;
  tilecount: unknown;
  autoTileCount: unknown;
  transaction?: Transaction;
}): Promise<number[]> {
  const passes = await Pass.findAll({
    where: {levelId: params.levelId},
    attributes: ['id', 'isWrongJudgement'],
    include: [{model: Judgement, as: 'judgements', required: false}],
    transaction: params.transaction,
  });

  const toTrue: number[] = [];
  const toFalse: number[] = [];
  for (const pass of passes) {
    const next = isWrongJudgement(pass.judgements, {
      tilecount: params.tilecount,
      autoTileCount: params.autoTileCount,
    });
    const prev = !!pass.isWrongJudgement;
    if (next === prev) continue;
    if (next) toTrue.push(pass.id);
    else toFalse.push(pass.id);
  }

  if (toTrue.length > 0) {
    await Pass.update(
      {isWrongJudgement: true},
      {where: {id: {[Op.in]: toTrue}}, transaction: params.transaction},
    );
  }
  if (toFalse.length > 0) {
    await Pass.update(
      {isWrongJudgement: false},
      {where: {id: {[Op.in]: toFalse}}, transaction: params.transaction},
    );
  }

  return [...toTrue, ...toFalse];
}
