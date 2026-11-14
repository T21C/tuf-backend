import assert from 'node:assert/strict';
import test from 'node:test';
import {rangeNumeric, snapToNearest} from './ratingNumeric.js';

test('rangeNumeric uses a point or the midpoint of two ends', () => {
  assert.equal(rangeNumeric(8, 9), 8.5);
  assert.equal(rangeNumeric(8, null), 8);
  assert.equal(rangeNumeric(null, 9), 9);
  assert.equal(rangeNumeric(2, 2), 2);
  assert.equal(rangeNumeric(null, null), null);
  assert.equal(rangeNumeric(undefined, undefined), null);
});

test('snapToNearest keeps the higher value on an equal distance', () => {
  const ladder = [8, 9].map((sortOrder) => ({sortOrder}));
  assert.equal(snapToNearest(ladder, (item) => item.sortOrder, 8.5)?.sortOrder, 9);
  assert.equal(snapToNearest([{sortOrder: 40}, {sortOrder: 41}], (item) => item.sortOrder, 40.5)?.sortOrder, 41);
  assert.equal(snapToNearest([1, 2, 3], (n) => n, 1.5), 2);
  assert.equal(snapToNearest([1, 2, 3], (n) => n, 2), 2);
  assert.equal(snapToNearest([], (n: number) => n, 1), null);
});
