import { parentPort } from 'worker_threads';
import {
  calculateRankedScore,
  calculateGeneralScore,
  calculatePPScore,
  calculateWFScore,
  calculate12KScore,
  calculateAverageXacc,
  countUniversalPasses,
  countWorldsFirstPasses,
  calculateTopDiff,
  calculateTop12KDiff,
} from '../misc/PlayerStatsCalculator';

if (!parentPort) {
  throw new Error('This file must be run as a worker thread');
}

parentPort.on('message', async ({ scores, passes }) => {
  try {
    const validScores = scores.filter((s: any) => !s.isDeleted);

    // Calculate all stats in parallel
    const [
      rankedScore,
      generalScore,
      ppScore,
      wfScore,
      score12k,
      averageXacc,
      universalPassCount,
      worldsFirstCount,
      topDiff,
      top12kDiff
    ] = await Promise.all([
      calculateRankedScore(validScores),
      calculateGeneralScore(validScores),
      calculatePPScore(validScores),
      calculateWFScore(validScores),
      calculate12KScore(validScores),
      calculateAverageXacc(validScores),
      countUniversalPasses(passes),
      countWorldsFirstPasses(passes),
      calculateTopDiff(passes),
      calculateTop12KDiff(passes)
    ]);

    parentPort!.postMessage({
      rankedScore,
      generalScore,
      ppScore,
      wfScore,
      score12k,
      averageXacc,
      universalPasses: universalPassCount,
      worldsFirstCount,
      topDiff,
      top12kDiff
    });
  } catch (error) {
    parentPort!.postMessage({
      error: error instanceof Error ? error.message : 'Unknown error in worker'
    });
  }
}); 