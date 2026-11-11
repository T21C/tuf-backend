import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectedTypeIds,
  parseCurationRatingPicks,
  picksAreEmpty,
} from './curationRatingPicks.js';

test('parseCurationRatingPicks reads nullable chart/vfx and unique misc ids', () => {
  const picks = parseCurationRatingPicks({
    chartTypeId: 2,
    vfxTypeId: null,
    miscTypeIds: [10, 10, 11, '12'],
  });
  assert.deepEqual(picks, {
    chartTypeId: 2,
    vfxTypeId: null,
    miscTypeIds: [10, 11, 12],
  });
  assert.equal(picksAreEmpty(picks), false);
  assert.deepEqual(collectedTypeIds(picks), [2, 10, 11, 12]);
});

test('empty picks are treated as a deleted vote', () => {
  const picks = parseCurationRatingPicks({
    chartTypeId: null,
    vfxTypeId: '',
    miscTypeIds: [],
  });
  assert.equal(picksAreEmpty(picks), true);
  assert.deepEqual(collectedTypeIds(picks), []);
});
