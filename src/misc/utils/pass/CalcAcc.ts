import {PassSubmissionJudgements} from '../../../models/submissions/PassSubmission.js';

export interface IJudgements {
  earlyDouble: number;
  earlySingle: number;
  ePerfect: number;
  perfect: number;
  lPerfect: number;
  lateSingle: number;
  lateDouble: number;
}

export function sumJudgements(inp: IJudgements): number {
  return (
    inp.earlyDouble +
    inp.earlySingle +
    inp.ePerfect +
    inp.lPerfect +
    inp.lateDouble +
    inp.lateSingle +
    inp.perfect
  );
}

export function tilecount(inp: IJudgements): number {
  return (
    inp.earlySingle + inp.ePerfect + inp.lPerfect + inp.lateSingle + inp.perfect
  );
}

export function calcAcc(inp: IJudgements | PassSubmissionJudgements): number {
  // Handle array format (from client)
  if (!inp) return 0.95;

  const judgements =
    inp instanceof PassSubmissionJudgements ? inp.dataValues : inp;

  const result =
    (judgements.perfect + // perfect
      (judgements.ePerfect + judgements.lPerfect) * 0.75 + // ePerfect + lPerfect
      (judgements.earlySingle + judgements.lateSingle) * 0.4 + // earlySingle + lateSingle
      (judgements.earlyDouble + judgements.lateDouble) * 0.2) / // earlyDouble + lateDouble
    sumJudgements(judgements);

  return result;
}
