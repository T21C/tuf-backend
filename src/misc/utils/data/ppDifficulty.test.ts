import assert from 'node:assert/strict';
import test from 'node:test';
import { derivePpDiffId, resolvePpDiffId } from './ppDifficulty.js';

const diffs = [
  {id: 1, baseScore: 0, sortOrder: 1, type: 'PGU'},
  {id: 2, baseScore: 100, sortOrder: 2, type: 'PGU'},
  {id: 3, baseScore: 240, sortOrder: 3, type: 'PGU'},
  {id: 4, baseScore: 240, sortOrder: 4, type: 'PGU'},
  {id: 5, baseScore: 1000, sortOrder: 5, type: 'PGU'},
  {id: 99, baseScore: 50, sortOrder: 99, type: 'LEGACY'},
];

test('derivePpDiffId returns null when PP score is unset', () => {
  assert.equal(derivePpDiffId(null, diffs), null);
  assert.equal(derivePpDiffId(0, diffs), null);
  assert.equal(derivePpDiffId(undefined, diffs), null);
});

test('derivePpDiffId picks the highest default band the score has reached', () => {
  assert.equal(derivePpDiffId(50, diffs), 1);
  assert.equal(derivePpDiffId(100, diffs), 2);
  assert.equal(derivePpDiffId(241, diffs), 4);
  assert.equal(derivePpDiffId(1000, diffs), 5);
  assert.equal(derivePpDiffId(9999, diffs), 5);
});

test('derivePpDiffId ignores LEGACY difficulties', () => {
  assert.equal(derivePpDiffId(50, diffs), 1);
});

test('resolvePpDiffId keeps an explicit pick and derives when missing or invalid', () => {
  assert.equal(resolvePpDiffId(1000, 2, diffs), 2);
  assert.equal(resolvePpDiffId(1000, 999, diffs), 5);
  assert.equal(resolvePpDiffId(100, undefined, diffs), 2);
  assert.equal(resolvePpDiffId(0, 2, diffs), null);
});
