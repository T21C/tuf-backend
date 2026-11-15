import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  BulkReferencePayloadError,
  findUnavailableLevelIds,
  normalizeBulkReferenceUpdates,
} from './bulkReferenceUpdates.js';

test('normalizeBulkReferenceUpdates rejects a non-array payload', () => {
  assert.throws(
    () => normalizeBulkReferenceUpdates({levelId: 1}),
    (error: unknown) => error instanceof BulkReferencePayloadError
      && error.message === 'references must be an array',
  );
});

test('normalizeBulkReferenceUpdates keeps the last type for a duplicated levelId', () => {
  assert.deepEqual(
    normalizeBulkReferenceUpdates([
      {levelId: 10, type: 'R'},
      {levelId: '11', type: 'I'},
      {levelId: 10, type: 'T'},
    ]),
    [
      {levelId: 10, type: 'T'},
      {levelId: 11, type: 'I'},
    ],
  );
});

test('normalizeBulkReferenceUpdates rejects zero, negative, and non-integer ids', () => {
  assert.throws(
    () => normalizeBulkReferenceUpdates([
      {levelId: 0, type: ''},
      {levelId: -4, type: 'R'},
      {levelId: '12a', type: 'I'},
      {type: 'T'},
    ]),
    (error: unknown) => {
      if (!(error instanceof BulkReferencePayloadError)) return false;
      assert.deepEqual(error.invalidLevelIds, [0, -4, '12a', undefined]);
      return true;
    },
  );
});

test('findUnavailableLevelIds reports missing and deleted levels', () => {
  assert.deepEqual(
    findUnavailableLevelIds(
      [1, 2, 3, 4],
      [
        {id: 1, isDeleted: 0},
        {id: '2', isDeleted: false},
        {id: 3, isDeleted: 1},
      ],
    ),
    [3, 4],
  );
});
