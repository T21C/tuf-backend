import {IDifficulty, IPass} from '../interfaces/models';

export interface Score {
  score: number;
  xacc: number;
  speed: number;
  isWorldsFirst: boolean;
  is12K: boolean;
  baseScore: number;
  isDeleted: boolean;
  levelId?: number;
}

export function calculateRankedScore(scores: Score[]): number {
  if (scores.length === 0) return 0;
  return scores
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .reduce((acc, score, index) => acc + score.score * Math.pow(0.9, index), 0);
}

export function calculateGeneralScore(scores: Score[]): number {
  if (scores.length === 0) return 0;
  return scores.reduce((sum, score) => sum + score.score, 0);
}

export function calculatePPScore(scores: Score[]): number {
  if (scores.length === 0) return 0;
  return scores
    .filter(score => score.xacc === 1.0)
    .reduce((sum, score) => sum + score.score, 0);
}

export function calculateWFScore(scores: Score[]): number {
  if (scores.length === 0) return 0;
  return scores
    .filter(score => score.isWorldsFirst)
    .reduce((sum, score) => sum + score.baseScore, 0);
}

export function calculate12KScore(scores: Score[]): number {
  if (scores.length === 0) return 0;
  return scores
    .filter(score => score.is12K)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .reduce((acc, score, index) => acc + score.score * Math.pow(0.9, index), 0);
}

export function calculateAverageXacc(scores: Score[]): number {
  if (scores.length === 0) return 0;
  const topScores = scores.sort((a, b) => b.score - a.score).slice(0, 20);
  return (
    topScores.reduce((sum, score) => sum + score.xacc, 0) / topScores.length
  );
}

export function countUniversalPasses(passes: IPass[]): number {
  return passes.filter(
    pass => !pass.isDeleted && pass.level?.difficulty?.name?.startsWith('U'),
  ).length;
}

export function countWorldsFirstPasses(passes: IPass[]): number {
  return passes.filter(pass => !pass.isDeleted && pass.isWorldsFirst).length;
}

export function calculateTopDiff(passes: IPass[]): IDifficulty | null {
  return calculateDiff(passes, false);
}

export function calculateTop12KDiff(passes: IPass[]): IDifficulty | null {
  return calculateDiff(passes, true);
}

export function calculateDiff(
  passes: IPass[],
  only12k: boolean,
): IDifficulty | null {
  let topDiff: IDifficulty | null = null;

  const validPasses = passes.filter(
    pass => !pass.isDeleted && (!only12k || pass.is12K),
  );
  if (validPasses.length === 0) return null;

  // Find the lowest difficulty as initial value
  const lowestDiff = validPasses.reduce(
    (lowest, pass) => {
      const diff = pass.level?.difficulty;
      if (!diff || diff.type !== 'PGU') return lowest;
      if (!lowest || diff.sortOrder < lowest.sortOrder) {
        return diff;
      }
      return lowest;
    },
    null as IDifficulty | null,
  );

  topDiff = lowestDiff;

  validPasses.forEach(pass => {
    const diff = pass.level?.difficulty;
    if (!diff || diff.type !== 'PGU') return;
    if (
      !topDiff ||
      diff.sortOrder > topDiff.sortOrder ||
      (diff.sortOrder === topDiff.sortOrder && diff.id > topDiff.id)
    ) {
      topDiff = diff;
    }
  });

  return topDiff;
}
