import { isPureXPerfect } from '@/misc/utils/pass/CalcAcc.js';

export type LevelClearSets = {
  cleared: Set<number>;
  purePerfect: Set<number>;
  pureXPerfect: Set<number>;
  best: Map<number, { accuracy: number; scoreV2: number; rank: number }>;
};

export type LevelClearFlags = {
  isCleared: boolean;
  isPurePerfect: boolean;
  isPureXPerfect: boolean;
  clearAccuracy: number | null;
  clearScore: number | null;
};

export type PassClearInput = {
  levelId?: number | null;
  accuracy?: number | null;
  scoreV2?: number | null;
  isXPerfectMode?: boolean | null;
  judgements?: unknown;
};

export function emptyClearSets(): LevelClearSets {
  return {
    cleared: new Set<number>(),
    purePerfect: new Set<number>(),
    pureXPerfect: new Set<number>(),
    best: new Map(),
  };
}

function clearRank(isPurePerfect: boolean, isPureXPerfect: boolean): number {
  if (isPureXPerfect) return 2;
  if (isPurePerfect) return 1;
  return 0;
}

export function classifyPassesIntoClearSets(passes: PassClearInput[]): LevelClearSets {
  const sets = emptyClearSets();
  for (const pass of passes) {
    if (pass.levelId == null) continue;
    sets.cleared.add(pass.levelId);
    const isPurePerfect = Number(pass.accuracy) >= 1 - 1e-9;
    const isPureXPerfectClear = isPureXPerfect(pass.judgements, pass.isXPerfectMode);
    if (isPurePerfect) {
      sets.purePerfect.add(pass.levelId);
    }
    if (isPureXPerfectClear) {
      sets.pureXPerfect.add(pass.levelId);
    }

    const accuracy = Number(pass.accuracy);
    const scoreV2 = Number(pass.scoreV2);
    const next = {
      accuracy: Number.isFinite(accuracy) ? accuracy : 0,
      scoreV2: Number.isFinite(scoreV2) ? scoreV2 : 0,
      rank: clearRank(isPurePerfect, isPureXPerfectClear),
    };
    const prev = sets.best.get(pass.levelId);
    if (
      !prev ||
      next.rank > prev.rank ||
      (next.rank === prev.rank && next.scoreV2 > prev.scoreV2)
    ) {
      sets.best.set(pass.levelId, next);
    }
  }
  return sets;
}

export function flagsFromClearSets(
  levelId: number | null | undefined,
  sets: LevelClearSets,
): LevelClearFlags {
  const id = levelId || 0;
  const best = sets.best.get(id);
  return {
    isCleared: sets.cleared.has(id),
    isPurePerfect: sets.purePerfect.has(id),
    isPureXPerfect: sets.pureXPerfect.has(id),
    clearAccuracy: best ? best.accuracy : null,
    clearScore: best ? best.scoreV2 : null,
  };
}
