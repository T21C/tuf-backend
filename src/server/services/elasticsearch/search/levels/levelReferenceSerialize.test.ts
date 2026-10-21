import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LEVEL_REFERENCE_ID_LIMIT,
  parseLevelReferenceIds,
  toLevelReference,
} from './levelReferenceSerialize.js';

test('parseLevelReferenceIds keeps unique positive integers in order', () => {
  assert.deepEqual(parseLevelReferenceIds('1686, 12,1686,0,-3,foo'), [1686, 12]);
});

test('parseLevelReferenceIds ignores non-strings and caps the list', () => {
  assert.deepEqual(parseLevelReferenceIds(undefined), []);
  assert.deepEqual(parseLevelReferenceIds({ ids: '1' }), []);
  assert.deepEqual(parseLevelReferenceIds(['1', '2']), [1, 2]);
  const raw = Array.from({ length: LEVEL_REFERENCE_ID_LIMIT + 5 }, (_, i) => i + 1).join(',');
  assert.equal(parseLevelReferenceIds(raw).length, LEVEL_REFERENCE_ID_LIMIT);
  assert.equal(parseLevelReferenceIds(raw)[0], 1);
});

test('toLevelReference keeps the fields a comment chip needs', () => {
  assert.deepEqual(
    toLevelReference({
      id: 1686,
      diffId: 20,
      song: 'Rocky Buinned',
      suffix: '(Short)',
      songObject: { id: 9, name: 'Rocky Buinned', aliases: [] },
      artist: 'Frums',
      toRate: true,
    }),
    {
      id: 1686,
      diffId: 20,
      song: 'Rocky Buinned',
      artist: 'Frums',
      suffix: '(Short)',
      toRate: true,
      songObject: { name: 'Rocky Buinned' },
    }
  );
  assert.equal(toLevelReference({id: 1, song: 'x'})?.toRate, false);
});

test('toLevelReference drops rows without a numeric id', () => {
  assert.equal(toLevelReference(null), null);
  assert.equal(toLevelReference({ song: 'x' }), null);
  assert.equal(toLevelReference({ id: 4, diffId: 'nope', songObject: null })?.diffId, null);
});
