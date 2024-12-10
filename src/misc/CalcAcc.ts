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

export function calcAcc(inp: IJudgements): number {
  // Handle array format (from client)

  if (inp) {
    const result =
      (inp.perfect + // perfect
        (inp.ePerfect + inp.lPerfect) * 0.75 + // ePerfect + lPerfect
        (inp.earlySingle + inp.lateSingle) * 0.4 + // earlySingle + lateSingle
        (inp.earlyDouble + inp.lateDouble) * 0.2) / // earlyDouble + lateDouble
      sumJudgements(inp);

    return result;
  }
  return 0.95;
}
