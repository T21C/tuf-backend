import { parentPort, isMainThread } from 'worker_threads';
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

// Ensure we're in a worker thread
if (isMainThread || !parentPort) {
  process.exit(1);
}

// Store parentPort in a variable to satisfy TypeScript
const port = parentPort;

// Handle uncaught errors
process.on('unhandledRejection', (error) => {
  console.error('Worker unhandled rejection:', error);
  port.postMessage({ error: error instanceof Error ? error.message : 'Unknown error in worker' });
});

process.on('uncaughtException', (error) => {
  console.error('Worker uncaught exception:', error);
  port.postMessage({ error: error instanceof Error ? error.message : 'Unknown error in worker' });
});

// Main worker message handler
port.on('message', async ({ scores, passes }) => {
  try {
    // Validate input
    if (!Array.isArray(scores) || !Array.isArray(passes)) {
      throw new Error('Invalid input: scores and passes must be arrays');
    }

    const validScores = scores.filter(s => !s.isDeleted && s !== null);

    // Calculate all stats in parallel with error handling
    const results = await Promise.all([
      Promise.resolve().then(() => calculateRankedScore(validScores)).catch(() => 0),
      Promise.resolve().then(() => calculateGeneralScore(validScores)).catch(() => 0),
      Promise.resolve().then(() => calculatePPScore(validScores)).catch(() => 0),
      Promise.resolve().then(() => calculateWFScore(validScores)).catch(() => 0),
      Promise.resolve().then(() => calculate12KScore(validScores)).catch(() => 0),
      Promise.resolve().then(() => calculateAverageXacc(validScores)).catch(() => 0),
      Promise.resolve().then(() => countUniversalPasses(passes)).catch(() => 0),
      Promise.resolve().then(() => countWorldsFirstPasses(passes)).catch(() => 0),
      Promise.resolve().then(() => calculateTopDiff(passes)).catch(() => null),
      Promise.resolve().then(() => calculateTop12KDiff(passes)).catch(() => null)
    ]);

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
    ] = results;

    port.postMessage({
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
    console.error('Worker calculation error:', error);
    port.postMessage({
      error: error instanceof Error ? error.message : 'Unknown error in worker'
    });
  }
}); 