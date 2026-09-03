import assert from 'node:assert/strict';
import test from 'node:test';
import { pickPeakRankHold } from './peakRankHold.js';

test('pickPeakRankHold uses the day before the drop of the latest peak hold', () => {
  const peak = pickPeakRankHold([
    { rankedScoreRank: 2, effectiveDay: '2023-01-01' },
    { rankedScoreRank: 3, effectiveDay: '2024-01-01' },
  ]);
  assert.deepEqual(peak, { rank: 2, date: '2023-12-31' });
});

test('pickPeakRankHold prefers the latest plateau when the peak was hit twice', () => {
  const peak = pickPeakRankHold([
    { rankedScoreRank: 2, effectiveDay: '2023-01-01' },
    { rankedScoreRank: 5, effectiveDay: '2023-06-01' },
    { rankedScoreRank: 2, effectiveDay: '2023-09-01' },
    { rankedScoreRank: 4, effectiveDay: '2024-01-01' },
  ]);
  assert.deepEqual(peak, { rank: 2, date: '2023-12-31' });
});

test('pickPeakRankHold keeps the start day when the player is still at peak', () => {
  const peak = pickPeakRankHold([{ rankedScoreRank: 1, effectiveDay: '2024-04-21' }]);
  assert.deepEqual(peak, { rank: 1, date: '2024-04-21' });
});

test('pickPeakRankHold ignores off-leaderboard ranks when choosing the peak', () => {
  const peak = pickPeakRankHold([
    { rankedScoreRank: -1, effectiveDay: '2023-01-01' },
    { rankedScoreRank: 10, effectiveDay: '2023-02-01' },
    { rankedScoreRank: 5, effectiveDay: '2023-03-01' },
    { rankedScoreRank: 8, effectiveDay: '2023-04-01' },
  ]);
  assert.deepEqual(peak, { rank: 5, date: '2023-03-31' });
});

test('pickPeakRankHold returns null when there is no positive rank', () => {
  assert.equal(pickPeakRankHold([{ rankedScoreRank: -1, effectiveDay: '2023-01-01' }]), null);
  assert.equal(pickPeakRankHold([]), null);
});
