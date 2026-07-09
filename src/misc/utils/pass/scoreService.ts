/**
 * Single entry point for persisted pass scores.
 * Keep API in sync with client/src/utils/scoreService.js
 */
import {calcAcc, type IJudgements} from './CalcAcc.js';
import {getScoreV2} from './CalcScore.js';

export type LevelScoreContext = {
  baseScore: number | null;
  ppBaseScore: number | null;
  difficulty: {name: string; baseScore: number};
  xaccCurveMeta?: unknown | null;
};

export type LevelScoreContextSource = {
  baseScore?: number | null;
  ppBaseScore?: number | null;
  xaccCurveMeta?: unknown | null;
  difficulty?: {
    name?: string;
    baseScore?: number | null;
  } | null;
};

export type PassScoreInput = {
  speed: number;
  judgements: IJudgements;
  isNoHoldTap?: boolean;
};

export type PassScoreResult = {
  scoreV2: number;
  accuracy: number;
};

export class PassScoreCalculationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PassScoreCalculationError';
  }
}

function resolveDifficulty(
  level: LevelScoreContextSource,
  overrides?: Partial<LevelScoreContext>,
): {name: string; baseScore: number} {
  const fromOverride = overrides?.difficulty;
  if (fromOverride?.name != null) {
    return {
      name: fromOverride.name,
      baseScore: fromOverride.baseScore ?? 0,
    };
  }

  const fromLevel = level.difficulty;
  if (fromLevel?.name != null) {
    return {
      name: fromLevel.name,
      baseScore: fromLevel.baseScore ?? 0,
    };
  }

  return {name: '', baseScore: 0};
}

function resolveXaccCurveMeta(
  level: LevelScoreContextSource,
  overrides?: Partial<LevelScoreContext>,
): unknown | null {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, 'xaccCurveMeta')) {
    return overrides.xaccCurveMeta ?? null;
  }
  return level.xaccCurveMeta ?? null;
}

/** Normalize any level-like object into a complete scoring context. */
export function buildLevelScoreContext(
  level: LevelScoreContextSource,
  overrides?: Partial<LevelScoreContext>,
): LevelScoreContext {
  return {
    baseScore:
      overrides?.baseScore !== undefined
        ? overrides.baseScore
        : (level.baseScore ?? null),
    ppBaseScore:
      overrides?.ppBaseScore !== undefined
        ? overrides.ppBaseScore
        : (level.ppBaseScore ?? null),
    difficulty: resolveDifficulty(level, overrides),
    xaccCurveMeta: resolveXaccCurveMeta(level, overrides),
  };
}

function assertFiniteScoreResult(result: PassScoreResult): PassScoreResult {
  if (!Number.isFinite(result.accuracy)) {
    throw new PassScoreCalculationError(
      'Invalid judgement values - could not calculate accuracy',
    );
  }
  if (!Number.isFinite(result.scoreV2)) {
    throw new PassScoreCalculationError(
      'Invalid judgement values - could not calculate score',
    );
  }
  return result;
}

/** Single entry point for all persisted pass scores. */
export function computePassScoreV2(
  pass: PassScoreInput,
  level: LevelScoreContextSource,
  overrides?: Partial<LevelScoreContext>,
): PassScoreResult {
  const levelContext = buildLevelScoreContext(level, overrides);
  const accuracy = calcAcc(pass.judgements);
  const scoreV2 = getScoreV2(
    {
      speed: pass.speed ?? 1,
      judgements: pass.judgements,
      isNoHoldTap: pass.isNoHoldTap ?? false,
    },
    levelContext,
  );

  return assertFiniteScoreResult({scoreV2, accuracy});
}

/** Bulk recalc helper — same level context for every pass on a level. */
export function computePassScoreV2Batch(
  passes: PassScoreInput[],
  levelContext: LevelScoreContext,
): PassScoreResult[] {
  return passes.map(pass => {
    const accuracy = calcAcc(pass.judgements);
    const scoreV2 = getScoreV2(
      {
        speed: pass.speed ?? 1,
        judgements: pass.judgements,
        isNoHoldTap: pass.isNoHoldTap ?? false,
      },
      levelContext,
    );
    return assertFiniteScoreResult({scoreV2, accuracy});
  });
}
