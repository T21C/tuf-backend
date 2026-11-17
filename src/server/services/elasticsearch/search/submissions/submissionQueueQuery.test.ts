import assert from 'node:assert/strict';
import test from 'node:test';
import { passDifficultySubtype, parseHiddenPassDifficultySubtypes } from '@/server/services/submissions/passDifficultySubtype.js';
import { difficultyTextSortValue } from '@/server/services/submissions/pendingSubmissionSort.js';
import {
  buildSubmissionQueueQuery,
  buildSubmissionQueueSort,
  cursorMatchesQuery,
  decodeSubmissionQueueCursor,
  encodeSubmissionQueueCursor,
  sortValueFromSource,
  type SubmissionQueueCursor,
} from './submissionQueueQuery.js';

test('pass difficulty subtype matches the admin hide groups', () => {
  assert.equal(passDifficultySubtype('P1'), 'P');
  assert.equal(passDifficultySubtype('G20'), 'G');
  assert.equal(passDifficultySubtype('U11 (old)'), 'U');
  assert.equal(passDifficultySubtype('GQ3'), 'GQ');
  assert.equal(passDifficultySubtype('UQ1'), 'UQ');
  assert.equal(passDifficultySubtype('Q2'), 'QQ');
  assert.equal(passDifficultySubtype('QQ'), 'QQ');
  assert.equal(passDifficultySubtype('Legacy'), 'Etc.');
  assert.equal(passDifficultySubtype(''), 'Etc.');
});

test('hide values reject unknown subtypes', () => {
  assert.deepEqual(parseHiddenPassDifficultySubtypes('P,G'), ['P', 'G']);
  assert.deepEqual(parseHiddenPassDifficultySubtypes('G,P'), ['P', 'G']);
  assert.deepEqual(parseHiddenPassDifficultySubtypes('P,P,G'), ['P', 'G']);
  assert.equal('error' in parseHiddenPassDifficultySubtypes('P,Z'), true);
  assert.deepEqual(parseHiddenPassDifficultySubtypes(''), []);
});

test('queue query filters kind and hidden subtypes, and searches searchText', () => {
  const query = buildSubmissionQueueQuery({ kind: 'pass', q: 'song', hide: ['P'] });
  const bool = query.bool as {
    filter: Array<Record<string, unknown>>;
    should: unknown[];
    minimum_should_match: number;
  };
  assert.deepEqual(bool.filter[0], { term: { kind: 'pass' } });
  assert.deepEqual(bool.filter[1], { bool: { must_not: { terms: { difficultySubtype: ['P'] } } } });
  assert.equal(bool.minimum_should_match, 1);
  assert.equal(bool.should.length > 0, true);

  const unfiltered = buildSubmissionQueueQuery({ kind: 'level', q: '', hide: [] });
  assert.deepEqual((unfiltered.bool as { filter: unknown[] }).filter, [{ term: { kind: 'level' } }]);
});

test('ratio sort uses ratio, accepted count, then decided count, with missing last', () => {
  const sort = buildSubmissionQueueSort('ratio', 'desc') as Array<Record<string, unknown>>;
  assert.deepEqual(sort[0], { isLocked: { order: 'asc' } });
  assert.deepEqual(sort[1], { ratio: { order: 'desc', missing: '_last' } });
  assert.deepEqual(sort[2], { acceptedCount: { order: 'desc', missing: '_last' } });
  assert.deepEqual(sort[3], { decidedCount: { order: 'desc', missing: '_last' } });
  assert.deepEqual(sort[4], { id: { order: 'desc' } });

  const difficulty = buildSubmissionQueueSort('difficulty', 'asc') as Array<Record<string, unknown>>;
  assert.deepEqual(difficulty[1], { difficultySort: { order: 'asc', missing: '_last' } });
});

test('search_after cursors round-trip and ignore a mismatched query', () => {
  const cursor: SubmissionQueueCursor = {
    v: 2,
    sort: 'ratio',
    dir: 'desc',
    hide: ['P'],
    q: 'song',
    after: [0, 750000, 10, 12, 9],
  };
  const encoded = encodeSubmissionQueueCursor(cursor);
  assert.deepEqual(decodeSubmissionQueueCursor(encoded), cursor);
  assert.equal(decodeSubmissionQueueCursor('not-a-cursor'), null);
  assert.equal(
    cursorMatchesQuery(cursor, { sort: 'ratio', dir: 'desc', hide: ['P'], q: 'song' }),
    true,
  );
  assert.equal(
    cursorMatchesQuery(cursor, { sort: 'ratio', dir: 'desc', hide: [], q: 'song' }),
    false,
  );
});

test('difficulty text and source sort values stay numeric', () => {
  const names = new Map([
    ['p1', 1],
    ['u11', 51],
    ['u13', 53],
  ]);
  assert.equal(difficultyTextSortValue('U11-13', names), 53);
  assert.equal(sortValueFromSource({ createdAt: '2024-05-02T00:00:00.000Z' }, 'submitted'), Date.parse('2024-05-02T00:00:00.000Z'));
  assert.equal(sortValueFromSource({ difficultySort: 40 }, 'difficulty'), 40);
  assert.equal(sortValueFromSource({ ratio: null }, 'ratio'), null);
});
