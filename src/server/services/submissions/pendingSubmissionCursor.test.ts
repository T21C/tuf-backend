import assert from 'node:assert/strict';
import test from 'node:test';
import {
  comparePendingBySort,
  comparePendingSubmissions,
  cursorFromPendingRow,
  decodePendingSubmissionCursor,
  encodePendingSubmissionCursor,
  isAfterPendingCursor,
  parsePendingSubmissionListQuery,
  pendingQueueRevision,
  slicePendingPage,
} from './pendingSubmissionCursor.js';
import { difficultyTextSortValue, ratioSortValue } from './pendingSubmissionSort.js';
import { encodeSubmissionQueueCursor } from '@/server/services/elasticsearch/search/submissions/submissionQueueQuery.js';

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
    sort: 'submitted',
    dir: 'desc',
    hide: [],
  });
  assert.deepEqual(parsePendingSubmissionListQuery({ limit: '10', q: ' song ' }), {
    limit: 10,
    cursor: null,
    q: 'song',
    ids: null,
    sort: 'submitted',
    dir: 'desc',
    hide: [],
  });
  assert.equal('error' in parsePendingSubmissionListQuery({ limit: '500' }), true);
  const badCursor = parsePendingSubmissionListQuery({ cursor: '%%%' });
  assert.equal('error' in badCursor, false);
  if (!('error' in badCursor)) assert.equal(badCursor.cursor, null);
  assert.equal('error' in parsePendingSubmissionListQuery({ ids: '1,0' }), true);
  assert.equal('error' in parsePendingSubmissionListQuery({ sort: 'score' }), true);
  assert.equal('error' in parsePendingSubmissionListQuery({ dir: 'sideways' }), true);
  assert.equal('error' in parsePendingSubmissionListQuery({ hide: 'nope' }), true);
  const hideQuery = parsePendingSubmissionListQuery({ hide: 'G,P' });
  assert.equal('error' in hideQuery, false);
  if (!('error' in hideQuery)) assert.deepEqual(hideQuery.hide, ['P', 'G']);
  const idsQuery = parsePendingSubmissionListQuery({ ids: '4,5' });
  assert.equal('error' in idsQuery, false);
  if (!('error' in idsQuery)) assert.deepEqual(idsQuery.ids, [4, 5]);
  const sorted = parsePendingSubmissionListQuery({ sort: 'difficulty', dir: 'ASC' });
  assert.equal('error' in sorted, false);
  if (!('error' in sorted)) {
    assert.equal(sorted.sort, 'difficulty');
    assert.equal(sorted.dir, 'asc');
  }
});

test('legacy cursors stay on newest submit time and a mismatched cursor restarts at the first page', () => {
  const legacy = Buffer.from(JSON.stringify({
    isLocked: 0,
    createdAt: '2024-05-02T00:00:00.000Z',
    id: 3,
  }), 'utf8').toString('base64url');
  const decoded = decodePendingSubmissionCursor(legacy);
  assert.equal(decoded?.sort, 'submitted');
  assert.equal(decoded?.dir, 'desc');
  assert.equal(decoded?.value, Date.parse('2024-05-02T00:00:00.000Z'));

  const v1Cursor = encodePendingSubmissionCursor(cursorFromPendingRow(rows[0], 'submitted', 'desc'));
  const restarted = parsePendingSubmissionListQuery({ cursor: v1Cursor, sort: 'ratio', dir: 'desc' });
  assert.equal('error' in restarted, false);
  if (!('error' in restarted)) assert.equal(restarted.cursor, null);

  const v2 = encodeSubmissionQueueCursor({
    v: 2,
    sort: 'submitted',
    dir: 'desc',
    hide: [],
    q: '',
    after: [0, '2024-05-02T00:00:00.000Z', 3],
  });
  const kept = parsePendingSubmissionListQuery({ cursor: v2, sort: 'submitted', dir: 'desc' });
  assert.equal('error' in kept, false);
  if (!('error' in kept)) {
    assert.equal(kept.cursor?.v, 2);
    assert.deepEqual(kept.cursor?.after, [0, '2024-05-02T00:00:00.000Z', 3]);
  }
});

test('difficulty and ratio sorts keep unlocked rows first and missing values last', () => {
  const difficultyRows = [
    { id: 1, isLocked: false, createdAt: '2024-05-01T00:00:00.000Z', sortValue: 10 },
    { id: 2, isLocked: false, createdAt: '2024-05-03T00:00:00.000Z', sortValue: 40 },
    { id: 3, isLocked: false, createdAt: '2024-05-02T00:00:00.000Z', sortValue: null },
    { id: 4, isLocked: true, createdAt: '2024-06-01T00:00:00.000Z', sortValue: 99 },
    { id: 5, isLocked: false, createdAt: '2024-05-02T00:00:00.000Z', sortValue: 40 },
  ];
  const hardestFirst = [...difficultyRows].sort((a, b) => comparePendingBySort(a, b, 'desc'));
  assert.deepEqual(hardestFirst.map((row) => row.id), [5, 2, 1, 3, 4]);

  const cursor = cursorFromPendingRow(hardestFirst[0], 'difficulty', 'desc');
  const { page, hasMore } = slicePendingPage(hardestFirst, cursor, 2);
  assert.deepEqual(page.map((row) => row.id), [2, 1]);
  assert.equal(hasMore, true);
  assert.equal(isAfterPendingCursor(hardestFirst[0], cursor), false);

  const ratioRows = [
    { id: 1, isLocked: false, createdAt: '2024-01-01T00:00:00.000Z', sortValue: 1_000_000 },
    { id: 2, isLocked: false, createdAt: '2024-01-01T00:00:00.000Z', sortValue: 0 },
    { id: 3, isLocked: false, createdAt: '2024-01-01T00:00:00.000Z', sortValue: null },
  ];
  const lowestRatioFirst = [...ratioRows].sort((a, b) => comparePendingBySort(a, b, 'asc'));
  assert.deepEqual(lowestRatioFirst.map((row) => row.id), [2, 1, 3]);
});

test('equal accept ratios break toward more accepted submissions, then more decided submissions', () => {
  const createdAt = '2024-01-01T00:00:00.000Z';
  const rows = [
    { id: 1, isLocked: false, createdAt, sortValue: 1_000_000, sortTie: 1, sortVolume: 1 },
    { id: 4, isLocked: false, createdAt, sortValue: 1_000_000, sortTie: 10, sortVolume: 10 },
    { id: 2, isLocked: false, createdAt, sortValue: 0, sortTie: 0, sortVolume: 2 },
    { id: 8, isLocked: false, createdAt, sortValue: 0, sortTie: 0, sortVolume: 8 },
    { id: 3, isLocked: false, createdAt, sortValue: 500_000, sortTie: 1, sortVolume: 2 },
    { id: 6, isLocked: false, createdAt, sortValue: 500_000, sortTie: 6, sortVolume: 12 },
  ];
  const highestFirst = [...rows].sort((a, b) => comparePendingBySort(a, b, 'desc'));
  assert.deepEqual(highestFirst.map((row) => row.id), [4, 1, 6, 3, 8, 2]);

  const cursor = cursorFromPendingRow(highestFirst[0], 'ratio', 'desc');
  assert.equal(cursor.tie, 10);
  assert.equal(cursor.volume, 10);
  const { page } = slicePendingPage(highestFirst, cursor, 3);
  assert.deepEqual(page.map((row) => row.id), [1, 6, 3]);
  assert.equal(isAfterPendingCursor(highestFirst[1], cursor), true);
  assert.equal(isAfterPendingCursor(highestFirst[0], cursor), false);

  const lowestFirst = [...rows].sort((a, b) => comparePendingBySort(a, b, 'asc'));
  assert.deepEqual(lowestFirst.map((row) => row.id), [2, 8, 3, 6, 1, 4]);
});

test('difficulty text and accept ratio become sortable numbers', () => {
  const names = new Map([
    ['p1', 1],
    ['g20', 40],
    ['u1', 41],
    ['u11', 51],
    ['u13', 53],
    ['q0', 61],
  ]);
  assert.equal(difficultyTextSortValue('U11', names), 51);
  assert.equal(difficultyTextSortValue('u11-13', names), 53);
  assert.equal(difficultyTextSortValue('G20-U1', names), 41);
  assert.equal(difficultyTextSortValue('P1+', names), 1);
  assert.equal(difficultyTextSortValue('Q0', names), 61);
  assert.equal(difficultyTextSortValue('nope', names), null);
  assert.equal(difficultyTextSortValue('', names), null);
  assert.equal(ratioSortValue(3, 1), 750_000);
  assert.equal(ratioSortValue(0, 4), 0);
  assert.equal(ratioSortValue(0, 0), null);
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
