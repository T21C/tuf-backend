import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectedTypeIds,
  CurationRatingPickError,
  normalizeCurationRange,
  parseCurationRatingPicks,
  picksAreEmpty,
  picksFromTypeRows,
  resolveCurationRatingString,
} from './curationRatingPicks.js';

const types = new Map([
  [16, {id: 16, name: 'C0'}],
  [17, {id: 17, name: 'C1'}],
  [18, {id: 18, name: 'C2'}],
  [19, {id: 19, name: 'C3'}],
  [23, {id: 23, name: 'O1'}],
  [21, {id: 21, name: 'V1'}],
  [26, {id: 26, name: 'V3'}],
]);

test('parseCurationRatingPicks reads nullable chart/vfx and unique misc ids', () => {
  const picks = parseCurationRatingPicks({
    chartTypeId: 2,
    vfxTypeId: null,
    miscTypeIds: [10, 10, 11, '12'],
  });
  assert.deepEqual(picks, {
    chartTypeId: 2,
    chartTypeHighId: null,
    vfxTypeId: null,
    vfxTypeHighId: null,
    chartRating: undefined,
    vfxRating: undefined,
    miscTypeIds: [10, 11, 12],
  });
  assert.equal(picksAreEmpty(picks), false);
  assert.deepEqual(collectedTypeIds(picks), [2, 10, 11, 12]);
});

test('parseCurationRatingPicks keeps optional range highs', () => {
  const picks = parseCurationRatingPicks({
    chartTypeId: 17,
    chartTypeHighId: 19,
    vfxTypeId: 21,
    vfxTypeHighId: 26,
    miscTypeIds: [],
  });
  assert.deepEqual(picks, {
    chartTypeId: 17,
    chartTypeHighId: 19,
    vfxTypeId: 21,
    vfxTypeHighId: 26,
    chartRating: undefined,
    vfxRating: undefined,
    miscTypeIds: [],
  });
  assert.deepEqual(collectedTypeIds(picks), [17, 19, 21, 26]);
});

test('picksFromTypeRows splits published types into chart, vfx, and misc', () => {
  const picks = picksFromTypeRows([
    {id: 1, name: 'C1'},
    {id: 2, name: 'V3'},
    {id: 3, name: 'Epic'},
    {id: 4, name: 'H1'},
  ]);
  assert.deepEqual(picks, {
    chartTypeId: 1,
    chartTypeHighId: null,
    vfxTypeId: 2,
    vfxTypeHighId: null,
    miscTypeIds: [3, 4],
  });
});

test('parseCurationRatingPicks keeps rating text for C0-1 style ranges', () => {
  const picks = parseCurationRatingPicks({
    chartRating: 'C0-1',
    vfxRating: 'V1~3',
    miscTypeIds: [],
  });
  assert.equal(picks.chartRating, 'C0-1');
  assert.equal(picks.vfxRating, 'V1~3');
  assert.equal(picksAreEmpty(picks), false);
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

test('normalizeCurationRange stores the lower tier first and drops a matching high', () => {
  assert.deepEqual(
    normalizeCurationRange(19, 17, types, 'chart', 'chartTypeId'),
    {typeId: 17, typeHighId: 19},
  );
  assert.deepEqual(
    normalizeCurationRange(18, 18, types, 'chart', 'chartTypeId'),
    {typeId: 18, typeHighId: null},
  );
  assert.deepEqual(
    normalizeCurationRange(null, 21, types, 'vfx', 'vfxTypeId'),
    {typeId: 21, typeHighId: null},
  );
});

test('resolveCurationRatingString copies prefix so C0-1 is C0 and C1', () => {
  assert.deepEqual(
    resolveCurationRatingString('C0-1', types.values(), 'chart', 'chartRating'),
    {typeId: 16, typeHighId: 17},
  );
  assert.deepEqual(
    resolveCurationRatingString('C2', types.values(), 'chart', 'chartRating'),
    {typeId: 18, typeHighId: null},
  );
  assert.deepEqual(
    resolveCurationRatingString('', types.values(), 'chart', 'chartRating'),
    {typeId: null, typeHighId: null},
  );
});

test('resolveCurationRatingString rejects a cross-family chart range', () => {
  assert.throws(
    () => resolveCurationRatingString('C2-O1', types.values(), 'chart', 'chartRating'),
    (error: unknown) =>
      error instanceof CurationRatingPickError &&
      error.status === 400 &&
      error.message === 'chartRating range must stay in the same family',
  );
});

test('normalizeCurationRange rejects a cross-family chart range', () => {
  assert.throws(
    () => normalizeCurationRange(18, 23, types, 'chart', 'chartTypeId'),
    (error: unknown) =>
      error instanceof CurationRatingPickError &&
      error.status === 400 &&
      error.message === 'chartTypeId range must stay in the same family',
  );
});
