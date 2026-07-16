/**
 * Single entry point for persisted pass scores.
 * Keep API in sync with client/src/utils/scoreService.js
 */
import {logger} from '@/server/services/core/LoggerService.js';
import {calcAcc, type IJudgements, sumJudgements} from './CalcAcc.js';
import {getScoreV2} from './CalcScore.js';
import {sanitizeJudgements} from './SanitizeJudgements.js';

export type LevelScoreContext = {
  baseScore: number | null;
  ppBaseScore: number | null;
  difficulty: {baseScore: number | null; name?: string};
  xaccCurveMeta?: unknown | null;
};

export type LevelScoreContextSource = {
  baseScore?: number | null;
  ppBaseScore?: number | null;
  xaccCurveMeta?: unknown | null;
  difficulty?: {
    name?: string | null;
    baseScore?: number | null;
  } | null;
};

export type PassScoreInput = {
  speed?: number | null;
  judgements?: IJudgements | null;
  isNoHoldTap?: boolean | null;
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
): {baseScore: number | null; name?: string} {
  const fromOverride = overrides?.difficulty;
  if (fromOverride != null) {
    return {
      name: fromOverride.name ?? undefined,
      baseScore:
        fromOverride.baseScore != null && Number.isFinite(fromOverride.baseScore)
          ? fromOverride.baseScore
          : null,
    };
  }

  const fromLevel = level.difficulty;
  if (fromLevel != null) {
    return {
      name: fromLevel.name ?? undefined,
      baseScore:
        fromLevel.baseScore != null && Number.isFinite(fromLevel.baseScore)
          ? fromLevel.baseScore
          : null,
    };
  }

  return {baseScore: null};
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

type NormalizedPass = {
  speed: number;
  judgements: IJudgements;
  isNoHoldTap: boolean;
  warnings: string[];
};

/** Best-effort normalize of pass fields; missing values get safe defaults + warnings. */
export function normalizePassScoreInput(pass: PassScoreInput): NormalizedPass {
  const warnings: string[] = [];

  let speed = 1;
  if (pass.speed == null || !Number.isFinite(Number(pass.speed))) {
    warnings.push('speed missing/invalid; defaulting to 1');
  } else {
    speed = Number(pass.speed);
  }

  let judgements: IJudgements;
  if (pass.judgements == null) {
    warnings.push('judgements missing; defaulting to zeros');
    judgements = sanitizeJudgements(null);
  } else {
    judgements = sanitizeJudgements(pass.judgements);
    if (sumJudgements(judgements) === 0) {
      warnings.push('judgements sum to zero; accuracy/score will be 0');
    }
  }

  const isNoHoldTap = pass.isNoHoldTap === true;

  return {speed, judgements, isNoHoldTap, warnings};
}

function logScoreGaps(
  label: string,
  warnings: string[],
  levelContext: LevelScoreContext,
  pass: NormalizedPass,
): void {
  if (!warnings.length) return;
  logger.warn(`[${label}] best-effort scoring with gaps`, {
    warnings,
    speed: pass.speed,
    isNoHoldTap: pass.isNoHoldTap,
    levelBaseScore: levelContext.baseScore,
    ppBaseScore: levelContext.ppBaseScore,
    difficultyBaseScore: levelContext.difficulty.baseScore,
  });
}

/** Single entry point for all persisted pass scores. */
export function computePassScoreV2(
  pass: PassScoreInput,
  level: LevelScoreContextSource,
  overrides?: Partial<LevelScoreContext>,
): PassScoreResult {
  const levelContext = buildLevelScoreContext(level, overrides);
  const normalized = normalizePassScoreInput(pass);

  const accuracy = calcAcc(normalized.judgements);
  // Difficulty is the last baseScore source; 0 is valid — only warn on non-numbers.
  if (!Number.isFinite(levelContext.difficulty.baseScore)) {
    normalized.warnings.push(
      'difficulty.baseScore missing/invalid (last baseScore source)',
    );
  }

  logScoreGaps('computePassScoreV2', normalized.warnings, levelContext, normalized);

  const scoreV2 = getScoreV2(
    {
      speed: normalized.speed,
      judgements: normalized.judgements,
      isNoHoldTap: normalized.isNoHoldTap,
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
  return passes.map((pass, index) => {
    const normalized = normalizePassScoreInput(pass);
    const accuracy = calcAcc(normalized.judgements);
    if (!Number.isFinite(levelContext.difficulty.baseScore)) {
      normalized.warnings.push(
        'difficulty.baseScore missing/invalid (last baseScore source)',
      );
    }
    logScoreGaps(
      `computePassScoreV2Batch[${index}]`,
      normalized.warnings,
      levelContext,
      normalized,
    );

    const scoreV2 = getScoreV2(
      {
        speed: normalized.speed,
        judgements: normalized.judgements,
        isNoHoldTap: normalized.isNoHoldTap,
      },
      levelContext,
    );
    return assertFiniteScoreResult({scoreV2, accuracy});
  });
}
