import assert from 'node:assert/strict';
import test from 'node:test';
import {
  emptyLevelLookups,
  emptyPassLookups,
  haystackIncludes,
  levelSubmissionMatchesSearch,
  normalizeSubmissionSearchQuery,
  passSubmissionMatchesSearch,
  uniquePositiveIds,
} from './submissionQueueSearchMatch.js';

test('normalizeSubmissionSearchQuery trims and caps length', () => {
  assert.equal(normalizeSubmissionSearchQuery('  foo  '), 'foo');
  assert.equal(normalizeSubmissionSearchQuery(''), '');
  assert.equal(normalizeSubmissionSearchQuery('x'.repeat(300)).length, 255);
});

test('uniquePositiveIds drops nulls and duplicates', () => {
  assert.deepEqual(uniquePositiveIds([1, 0, null, 1, 2, undefined, -3]), [1, 2]);
});

test('haystackIncludes is case-insensitive substring', () => {
  assert.equal(haystackIncludes('Cam', ['camellia', 'other']), true);
  assert.equal(haystackIncludes('zzz', ['camellia']), false);
  assert.equal(haystackIncludes('12', [12, 'ab']), true);
});

test('level submissions match ES-mapped creator/song ids and DB-only fields', () => {
  const row = {
    id: 9,
    song: 'Raw Song',
    artist: 'Raw Artist',
    charter: 'CharterName',
    suffix: 'Nerfed',
    diff: 'U1',
    songId: 40,
    creatorRequests: [{creatorId: 7, creatorName: 'Unlinked'}],
    levelSubmitter: {username: 'alice', playerId: 3},
  };

  assert.equal(
    levelSubmissionMatchesSearch(row, 'nerfed', emptyLevelLookups()),
    true,
  );
  assert.equal(
    levelSubmissionMatchesSearch(row, 'alice', emptyLevelLookups()),
    true,
  );
  assert.equal(
    levelSubmissionMatchesSearch(row, 'nope', emptyLevelLookups()),
    false,
  );

  const creatorHit = emptyLevelLookups();
  creatorHit.creatorIds.add(7);
  assert.equal(levelSubmissionMatchesSearch(row, 'alias-only', creatorHit), true);

  const songHit = emptyLevelLookups();
  songHit.songIds.add(40);
  assert.equal(levelSubmissionMatchesSearch(row, 'alias-only', songHit), true);
});

test('pass submissions match ES-mapped level/player ids and DB-only fields', () => {
  const row = {
    id: 5,
    title: 'Clear video',
    passer: 'Bob',
    passerId: 11,
    assignedPlayerId: 12,
    levelId: 80,
    feelingDifficulty: 'G18',
    passSubmitter: {username: 'carol', playerId: 4},
  };

  assert.equal(passSubmissionMatchesSearch(row, 'g18', emptyPassLookups()), true);
  assert.equal(passSubmissionMatchesSearch(row, 'carol', emptyPassLookups()), true);
  assert.equal(passSubmissionMatchesSearch(row, 'nope', emptyPassLookups()), false);

  const levelHit = emptyPassLookups();
  levelHit.levelIds.add(80);
  assert.equal(passSubmissionMatchesSearch(row, 'song-alias', levelHit), true);

  const playerHit = emptyPassLookups();
  playerHit.playerIds.add(12);
  assert.equal(passSubmissionMatchesSearch(row, 'player-alias', playerHit), true);
});
