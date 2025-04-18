import {IDifficulty, IPass} from '../interfaces/models/index.js';
import { PlayerStatsService } from '../services/PlayerStatsService.js';



export function calculateRankedScore(passes: IPass[]): number {
  if (passes.length === 0) return 0;
  
  // Pre-sort and slice once
  const top20 = passes
    .sort((a, b) => (b.scoreV2 || 0) - (a.scoreV2 || 0))
    .slice(0, 20);
    
  return top20.reduce((acc, score, index) => 
    acc + (score.scoreV2 || 0) * Math.pow(0.9, index), 0);
}

export function calculateGeneralScore(passes: IPass[]): number {
  if (passes.length === 0) return 0;
  return passes.reduce((sum, score) => sum + (score.scoreV2 || 0), 0);
}

export function calculatePPScore(passes: IPass[]): number {
  if (passes.length === 0) return 0;
  return passes
    .filter(pass => pass.accuracy === 1.0)
    .reduce((sum, pass) => sum + (pass.scoreV2 || 0), 0);
}

export function calculateWFScore(passes: IPass[]): number {
  if (passes.length === 0) return 0;
  return passes
    .filter(pass => pass.isWorldsFirst)
    .reduce((sum, pass) => sum + (pass.level?.baseScore || 0), 0);
}

export function calculate12KScore(passes: IPass[]): number {
  if (passes.length === 0) return 0;
  
  // Pre-filter and sort once
  const top20 = passes
    .filter(pass => pass.is12K)
    .sort((a, b) => (b.scoreV2 || 0) - (a.scoreV2 || 0))
    .slice(0, 20);
    
  return top20.reduce((acc, score, index) => 
    acc + (score.scoreV2 || 0) * Math.pow(0.9, index), 0);
}

export function calculateAverageXacc(passes: IPass[]): number {
  if (passes.length === 0) return 0;
  
  // Pre-sort and slice once
  const top20 = passes
    .sort((a, b) => (b.scoreV2 || 0) - (a.scoreV2 || 0))
    .slice(0, 20);
    
  if (top20.length === 0) return 0;
  return top20.reduce((sum, score) => sum + (score.accuracy || 0), 0) / top20.length;
}

export function countUniversalPassCount(passes: IPass[]): number {
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
