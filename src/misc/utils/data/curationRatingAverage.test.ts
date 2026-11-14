import assert from 'node:assert/strict';
import test from 'node:test';
import {averageCurationRatingPicks} from './curationRatingAverage.js';

const types = [
  {id: 16, name: 'C0'},
  {id: 17, name: 'C1'},
  {id: 18, name: 'C2'},
  {id: 19, name: 'C3'},
  {id: 23, name: 'O1'},
  {id: 24, name: 'O2'},
  {id: 25, name: 'O3'},
  {id: 20, name: 'V0'},
  {id: 21, name: 'V1'},
  {id: 22, name: 'V2'},
  {id: 26, name: 'V3'},
  {id: 7, name: 'Epic'},
];

test('C0-1 is one vote of 0.5, then the pool mean snaps once', () => {
  assert.deepEqual(
    averageCurationRatingPicks([{chartTypeId: 16, chartTypeHighId: 17}], types),
    {chartTypeId: 17, vfxTypeId: null},
  );
});

test('a range vote is one midpoint, then the pool mean snaps once', () => {
  assert.deepEqual(
    averageCurationRatingPicks(
      [
        {chartTypeId: 17, chartTypeHighId: 19},
        {chartTypeId: 18},
      ],
      types,
    ),
    {chartTypeId: 18, vfxTypeId: null},
  );
});

test('equal-distance chart mean snaps to the higher tier', () => {
  assert.deepEqual(
    averageCurationRatingPicks([{chartTypeId: 17}, {chartTypeId: 18}], types),
    {chartTypeId: 18, vfxTypeId: null},
  );
});

test('a missing high id stays a point vote', () => {
  assert.deepEqual(
    averageCurationRatingPicks([{chartTypeId: 19, vfxTypeId: 22}], types),
    {chartTypeId: 19, vfxTypeId: 22},
  );
});

test('majority chart family wins; a C/O tie yields no chart average', () => {
  assert.equal(
    averageCurationRatingPicks(
      [{chartTypeId: 17}, {chartTypeId: 17}, {chartTypeId: 24}],
      types,
    ).chartTypeId,
    17,
  );
  assert.equal(
    averageCurationRatingPicks([{chartTypeId: 17}, {chartTypeId: 23}], types).chartTypeId,
    null,
  );
});

test('VFX averages on the V ladder', () => {
  assert.equal(
    averageCurationRatingPicks(
      [
        {vfxTypeId: 21, vfxTypeHighId: 26},
        {vfxTypeId: 22},
      ],
      types,
    ).vfxTypeId,
    22,
  );
});

test('a cross-family chart range does not count toward the average', () => {
  assert.equal(
    averageCurationRatingPicks(
      [{chartTypeId: 18, chartTypeHighId: 23}, {chartTypeId: 17}],
      types,
    ).chartTypeId,
    17,
  );
});
