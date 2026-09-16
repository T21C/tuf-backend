import type { IJudgements } from '@/misc/utils/pass/CalcAcc.js';
import { preparePassJudgementsForPersist } from '@/misc/utils/pass/passEraApply.js';
import {
  computePassScoreV2,
  type LevelScoreContextSource,
} from '@/misc/utils/pass/scoreService.js';
import type { RegistrationInput } from './registrationSchema.js';

export type AutoSubmissionLevelScoreContext = LevelScoreContextSource & {
  /** Current official chart analysis stored on the level row. */
  midspinCount?: unknown;
};

/**
 * Maps the stable nine-slot contract to TUF's named judgement columns, applies
 * the same era/XPerfect/midspin preparation as ordinary pass submissions, and
 * scores only the prepared counts. A missing current Level.midspinCount follows
 * the existing shared helper's `midspin_missing` behavior; it is not guessed.
 */
export function prepareAutoSubmissionResult(
  validation: RegistrationInput['validation'],
  level: AutoSubmissionLevelScoreContext,
) {
  const counts = validation.judgments;
  const judgements: IJudgements = {
    earlyDouble: counts[1],
    earlySingle: counts[2],
    ePerfect: counts[3],
    perfectMinus: validation.perfect_minus,
    perfect: counts[4],
    perfectPlus: validation.perfect_plus,
    lPerfect: counts[5],
    lateSingle: counts[6],
    lateDouble: counts[7],
  };

  const prepared = preparePassJudgementsForPersist({
    judgements,
    adofaiVersion: validation.adofai_version,
    isXPerfectMode: validation.is_x_perfect_mode,
    passMetaFlags: 0,
    midspinCount: level.midspinCount,
  });
  const score = computePassScoreV2({
    speed: validation.speed,
    judgements: prepared.judgements,
    isNoHoldTap: validation.is_no_hold_tap,
  }, level);

  return {
    judgements: prepared.judgements,
    accuracy: score.accuracy,
    scoreV2: score.scoreV2,
    adofaiVersion: validation.adofai_version,
    isAdofaiV2: prepared.isAdofaiV2,
    isXPerfectMode: prepared.isXPerfectMode,
    passMetaFlags: prepared.passMetaFlagsDb,
    midspinDecrement: prepared.decrement,
  };
}
