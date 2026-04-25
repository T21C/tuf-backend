import type {PlayerFunFactsJudgements} from '@/server/interfaces/stats/funFacts.js';

export type DifficultyTypeCounts = {
  PGU: number;
  SPECIAL: number;
};

export function emptyClearsByDifficultyType(): DifficultyTypeCounts {
  return {PGU: 0, SPECIAL: 0};
}

export function mergeDifficultyTypeCounts(
  base: DifficultyTypeCounts,
  type: string | null | undefined,
  count: number,
): void {
  const t = String(type || '').toUpperCase();
  if (t === 'PGU') base.PGU += count;
  else if (t === 'SPECIAL') base.SPECIAL += count;
}

export function deriveJudgementRatios(raw: {
  totalTilesHit: number;
  perfect: number;
  earlyDouble: number;
  earlySingle: number;
  lateSingle: number;
  lateDouble: number;
}): Pick<PlayerFunFactsJudgements, 'totalXacc' | 'earlyVsLateBias'> {
  const total = Number(raw.totalTilesHit) || 0;
  const perfect = Number(raw.perfect) || 0;
  const early =
    (Number(raw.earlyDouble) || 0) +
    (Number(raw.earlySingle) || 0);
  const late =
    (Number(raw.lateSingle) || 0) +
    (Number(raw.lateDouble) || 0);
  const totalXacc = total > 0 ? perfect / total : 0;
  const earlyLateTotal = early + late;
  const earlyVsLateBias = earlyLateTotal > 0 ? (early - late) / earlyLateTotal : 0;
  return {totalXacc, earlyVsLateBias};
}
