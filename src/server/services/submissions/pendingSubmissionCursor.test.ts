import assert from 'node:assert/strict';
import test from 'node:test';
import {
  comparePendingSubmissions,
  cursorFromPendingRow,
  decodePendingSubmissionCursor,
  encodePendingSubmissionCursor,
  isAfterPendingCursor,
  parsePendingSubmissionListQuery,
  pendingQueueRevision,
} from './pendingSubmissionCursor.js';

const rows = [
  { id: 3, isLocked: false, createdAt: '2024-05-02T00:00:00.000Z' },
  { id: 9, isLocked: false, createdAt: '2024-05-01T00:00:00.000Z' },
  { id: 2, isLocked: false, createdAt: '2024-05-01T00:00:00.000Z' },
  { id: 1, isLocked: true, createdAt: '2024-06-01T00:00:00.000Z' },
];

test('cursor round-trips and rejects malformed values', () => {
  const cursor = cursorFromPendingRow(rows[0]);
  const encoded = encodePendingSubmissionCursor(cursor);
  assert.deepEqual(decodePendingSubmissionCursor(encoded), cursor);
  assert.equal(decodePendingSubmissionCursor('not-a-cursor'), null);
  assert.equal(decodePendingSubmissionCursor(''), null);
});

test('keyset order keeps locked rows after unlocked rows and stays stable when earlier rows disappear', () => {
  const sorted = [...rows].sort(comparePendingSubmissions);
  assert.deepEqual(sorted.map((row) => row.id), [3, 9, 2, 1]);

  const cursor = cursorFromPendingRow(sorted[0]);
  const rest = sorted.slice(1);
  assert.equal(isAfterPendingCursor(sorted[0], cursor), false);
  assert.equal(rest.every((row) => isAfterPendingCursor(row, cursor)), true);

  const withoutHead = sorted.slice(1);
  const nextCursor = cursorFromPendingRow(withoutHead[0]);
  const tail = withoutHead.slice(1);
  assert.equal(tail.every((row) => isAfterPendingCursor(row, nextCursor)), true);
  assert.equal(isAfterPendingCursor(sorted[0], nextCursor), false);
});

test('list query clamps paging and rejects a bad cursor or id list', () => {
  assert.deepEqual(parsePendingSubmissionListQuery({}), {
    limit: 15,
    cursor: null,
    q: '',
    ids: null,
  });
  assert.deepEqual(parsePendingSubmissionListQuery({ limit: '10', q: ' song ' }), {
    limit: 10,
    cursor: null,
    q: 'song',
    ids: null,
  });
  assert.equal('error' in parsePendingSubmissionListQuery({ limit: '500' }), true);
  assert.equal('error' in parsePendingSubmissionListQuery({ cursor: '%%%' }), true);
  assert.equal('error' in parsePendingSubmissionListQuery({ ids: '1,0' }), true);
  const idsQuery = parsePendingSubmissionListQuery({ ids: '4,5' });
  assert.equal('error' in idsQuery, false);
  if (!('error' in idsQuery)) assert.deepEqual(idsQuery.ids, [4, 5]);
});

test('queue revision changes when the pending set is updated', () => {
  assert.equal(pendingQueueRevision(3, null), '3:0');
  assert.notEqual(
    pendingQueueRevision(3, '2024-05-01T00:00:00.000Z'),
    pendingQueueRevision(2, '2024-05-01T00:00:00.000Z'),
  );
  assert.notEqual(
    pendingQueueRevision(3, '2024-05-01T00:00:00.000Z'),
    pendingQueueRevision(3, '2024-05-02T00:00:00.000Z'),
  );
});
