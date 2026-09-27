import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampRankRange,
  intersectRankedScoreFilters,
  parseRankedScoreRankRange,
  rankedScoreWindowForClampedRange,
} from './rankedScoreRankWindow.js';

/** Descending ranked scores. Positions 2 and 3 tie at 900 (shared rank 2; rank 3 is a gap). */
const SCORES_DESC = [1000, 900, 900, 800, 700];

function scoreAt(position: number): number | null {
  if (position < 1 || position > SCORES_DESC.length) return null;
  return SCORES_DESC[position - 1];
}

function windowFor(minRank: number, maxRank: number, population = SCORES_DESC.length) {
  const clamped = clampRankRange(minRank, maxRank, population);
  if (clamped.kind !== 'range') return clamped;
  return rankedScoreWindowForClampedRange(clamped, {
    atMax: scoreAt(clamped.max),
    atMinMinusOne: clamped.min > 1 ? scoreAt(clamped.min - 1) : null,
  });
}

void test('parseRankedScoreRankRange requires two finite numbers', () => {
  assert.equal(parseRankedScoreRankRange(null), null);
  assert.equal(parseRankedScoreRankRange([1]), null);
  assert.equal(parseRankedScoreRankRange(['a', 'b']), null);
  assert.deepEqual(parseRankedScoreRankRange([2.9, 10.1]), {min: 2, max: 10});
});

void test('clampRankRange treats a full span as all and an overshooting min as empty', () => {
  assert.deepEqual(clampRankRange(1, 5, 5), {kind: 'all'});
  assert.deepEqual(clampRankRange(1, 99, 5), {kind: 'all'});
  assert.deepEqual(clampRankRange(6, 10, 5), {kind: 'empty'});
  assert.deepEqual(clampRankRange(2, 4, 5), {kind: 'range', min: 2, max: 4});
  assert.deepEqual(clampRankRange(4, 99, 5), {kind: 'range', min: 4, max: 5});
});

void test('rank 1 only is a lower bound on the top score', () => {
  assert.deepEqual(windowFor(1, 1), {type: 'range', gte: 1000});
});

void test('a tied rank includes every player with that score', () => {
  assert.deepEqual(windowFor(2, 2), {type: 'range', gte: 900, lt: 1000});
});

void test('a gap rank inside a tie is empty', () => {
  assert.deepEqual(windowFor(3, 3), {type: 'empty'});
});

void test('a range covering a gap still includes ranks that exist in the span', () => {
  assert.deepEqual(windowFor(2, 4), {type: 'range', gte: 800, lt: 1000});
  assert.deepEqual(windowFor(3, 4), {type: 'range', gte: 800, lt: 900});
});

void test('intersectRankedScoreFilters combines rank and stat bounds', () => {
  const rankOnly = intersectRankedScoreFilters({type: 'range', gte: 800, lt: 1000}, null);
  assert.deepEqual(rankOnly, {empty: false, bounds: {gte: 800, lt: 1000}});

  const withStat = intersectRankedScoreFilters({type: 'range', gte: 800, lt: 1000}, [0, 850]);
  assert.deepEqual(withStat, {empty: false, bounds: {gte: 800, lt: 1000, lte: 850}});

  const disjoint = intersectRankedScoreFilters({type: 'range', gte: 800, lt: 1000}, [0, 100]);
  assert.deepEqual(disjoint, {empty: true});

  const allWithStat = intersectRankedScoreFilters({type: 'all'}, [10, 20]);
  assert.deepEqual(allWithStat, {empty: false, bounds: {gte: 10, lte: 20}});

  const allNoStat = intersectRankedScoreFilters({type: 'all'}, null);
  assert.deepEqual(allNoStat, {empty: false, bounds: null});
});
