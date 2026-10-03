export type ChartLinkPassCandidate = {
  id: number | null;
  levelId: number;
  scoreV2: number | null;
  isDuplicate: boolean;
  isDuplicateOverridden: boolean;
};

export type ChartLinkDuplicateGuess = {
  markNewPass: boolean;
  existingPassIds: number[];
};

function scoreOf(pass: ChartLinkPassCandidate): number {
  const n = Number(pass.scoreV2);
  return Number.isFinite(n) ? n : 0;
}

/** Lower-scoring clears on non-keeper levels in a shared chart subgroup. Never unmarks. */
export function guessChartLinkDuplicatePasses(
  passes: ChartLinkPassCandidate[],
): ChartLinkDuplicateGuess {
  if (passes.length === 0) {
    return {markNewPass: false, existingPassIds: []};
  }

  let best = -Infinity;
  for (const pass of passes) {
    const score = scoreOf(pass);
    if (score > best) best = score;
  }

  const keeperLevelIds = new Set<number>();
  for (const pass of passes) {
    if (scoreOf(pass) === best) keeperLevelIds.add(pass.levelId);
  }

  let markNewPass = false;
  const existingPassIds: number[] = [];
  for (const pass of passes) {
    if (pass.isDuplicateOverridden || pass.isDuplicate) continue;
    if (keeperLevelIds.has(pass.levelId)) continue;
    if (!(scoreOf(pass) < best)) continue;
    if (pass.id == null) markNewPass = true;
    else existingPassIds.push(pass.id);
  }

  return {markNewPass, existingPassIds};
}
