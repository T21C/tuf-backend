import {PGU_SORT, PguLetter} from '../config/constants';
import {IPass} from '../interfaces/models';

interface Score {
  score: number;
  xacc: number;
  isWorldsFirst: boolean;
  is12K: boolean;
  baseScore: number;
  isDeleted: boolean;
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
    .reduce(
      (acc, score, index) => acc + score.score * Math.pow(0.95, index),
      0,
    );
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

export function calculateTopDiff(passes: IPass[]): string {
  return calculateDiff(passes, false);
}

export function calculateTop12KDiff(passes: IPass[]): string {
  return calculateDiff(passes, true);
}

export function calculateDiff(passes: IPass[], only12k: boolean): string {
  let topLetter: PguLetter = 'P';
  let topNumber = 1;

  const validPasses = passes.filter(
    pass => !pass.isDeleted && (!only12k || pass.is12K),
  );
  if (validPasses.length === 0) return 'P1';

  validPasses.forEach(pass => {
    const pguDiff = pass.level?.difficulty?.name;
    if (!pguDiff) return;

    const letter = pguDiff[0] as PguLetter;
    const number = parseInt(pguDiff.slice(1));

    if (
      PGU_SORT[letter] > PGU_SORT[topLetter] ||
      (PGU_SORT[letter] === PGU_SORT[topLetter] && number > topNumber)
    ) {
      topLetter = letter;
      topNumber = number;
    }
  });

  return `${topLetter}${topNumber}`;
}
