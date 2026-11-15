import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isWatchablePguDifficultyName} from './pguDifficulty.js';
import {
  joinDifficultyNames,
  referenceChangeDedupKey,
  referenceChartChangeKind,
} from './referenceChange.js';

test('watchable PGU names match a single letter plus digits', () => {
  assert.equal(isWatchablePguDifficultyName('P13'), true);
  assert.equal(isWatchablePguDifficultyName('G1'), true);
  assert.equal(isWatchablePguDifficultyName('U20'), true);
  assert.equal(isWatchablePguDifficultyName('PGU1'), false);
  assert.equal(isWatchablePguDifficultyName('Legacy'), false);
});

test('chart change kind prefers deleted, then hidden, then file, then rerated', () => {
  const base = {
    id: 12,
    fileId: 'abc',
    dlLink: 'https://cdn.example/a',
    diffId: 4,
    isHidden: 0,
    isDeleted: 0,
  };

  assert.equal(
    referenceChartChangeKind(base, {...base, isDeleted: 1, isHidden: 1, fileId: 'zzz', diffId: 9}),
    'deleted',
  );
  assert.equal(
    referenceChartChangeKind(base, {...base, isHidden: 1, fileId: 'zzz', diffId: 9}),
    'hidden',
  );
  assert.equal(
    referenceChartChangeKind(base, {...base, fileId: 'zzz', diffId: 9}),
    'file',
  );
  assert.equal(
    referenceChartChangeKind(base, {...base, dlLink: 'https://cdn.example/b', diffId: 9}),
    'file',
  );
  assert.equal(referenceChartChangeKind(base, {...base, diffId: 9}), 'rerated');
  assert.equal(referenceChartChangeKind(base, {...base}), null);
  assert.equal(referenceChartChangeKind(base, null), 'deleted');
  assert.equal(referenceChartChangeKind(null, base), null);
  assert.equal(referenceChartChangeKind(base, {...base, isDeleted: 0}), null);
});

test('dedup keys use the new value, not a timestamp', () => {
  assert.equal(
    referenceChangeDedupKey({kind: 'added', levelId: 3042, difficultyId: 13}),
    'reference:added:13:3042',
  );
  assert.equal(
    referenceChangeDedupKey({kind: 'removed', levelId: 3042, difficultyId: 13}),
    'reference:removed:13:3042',
  );
  assert.equal(
    referenceChangeDedupKey({kind: 'type', levelId: 3042, difficultyId: 13, type: 'ROLLING'}),
    'reference:type:13:3042:ROLLING',
  );
  assert.equal(
    referenceChangeDedupKey({kind: 'file', levelId: 3042, fileId: 'file-9'}),
    'reference:file:3042:file-9',
  );
  assert.equal(
    referenceChangeDedupKey({kind: 'file', levelId: 3042, dlLink: 'https://cdn.example/a'}),
    'reference:file:3042:https://cdn.example/a',
  );
  assert.equal(
    referenceChangeDedupKey({kind: 'rerated', levelId: 3042, diffId: 14}),
    'reference:rerated:3042:14',
  );
  assert.equal(
    referenceChangeDedupKey({kind: 'hidden', levelId: 3042, isHidden: true}),
    'reference:hidden:3042:1',
  );
  assert.equal(referenceChangeDedupKey({kind: 'deleted', levelId: 3042}), 'reference:deleted:3042');
  assert.equal(joinDifficultyNames(['P12', 'P13']), 'P12, P13');
});
