import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseZenDeckSize,
  parseZenIncludeBands,
  peeksAllowedForDeckSize,
  ZEN_MAX_DECK_SIZE,
  ZEN_MIN_DECK_SIZE,
} from './zenRatingConstants.js';

test('parseZenIncludeBands defaults to including all bands', () => {
  assert.deepEqual(parseZenIncludeBands({}), {
    includeP: true,
    includeG: true,
    includeU: true,
  });
});

test('parseZenIncludeBands maps legacy onlyLowDiff to P only', () => {
  assert.deepEqual(parseZenIncludeBands({ onlyLowDiff: 'true' }), {
    includeP: true,
    includeG: false,
    includeU: false,
  });
});

test('parseZenIncludeBands maps legacy excludeUniversals to no U', () => {
  assert.deepEqual(parseZenIncludeBands({ excludeUniversals: true }), {
    includeP: true,
    includeG: true,
    includeU: false,
  });
});

test('parseZenIncludeBands prefers explicit include flags', () => {
  assert.deepEqual(
    parseZenIncludeBands({
      includeP: 'false',
      includeU: 'true',
      onlyLowDiff: true,
    }),
    {
      includeP: false,
      includeG: true,
      includeU: true,
    }
  );
});

test('parseZenDeckSize accepts integers from 1 to 200 including non-presets', () => {
  assert.equal(parseZenDeckSize(1), 1);
  assert.equal(parseZenDeckSize('37'), 37);
  assert.equal(parseZenDeckSize(159), 159);
  assert.equal(parseZenDeckSize(ZEN_MIN_DECK_SIZE), ZEN_MIN_DECK_SIZE);
  assert.equal(parseZenDeckSize(ZEN_MAX_DECK_SIZE), ZEN_MAX_DECK_SIZE);
  assert.equal(parseZenDeckSize(15.9), 15);
});

test('parseZenDeckSize rejects empty, non-numeric, and out-of-range values', () => {
  assert.throws(() => parseZenDeckSize(''), { status: 400 });
  assert.throws(() => parseZenDeckSize('abc'), { status: 400 });
  assert.throws(() => parseZenDeckSize(0), { status: 400 });
  assert.throws(() => parseZenDeckSize(201), { status: 400 });
  assert.throws(() => parseZenDeckSize(-3), { status: 400 });
});

test('peeksAllowedForDeckSize floors to the 5-card unit from the actual deck', () => {
  assert.equal(peeksAllowedForDeckSize(200), 40);
  assert.equal(peeksAllowedForDeckSize(159), 31);
  assert.equal(peeksAllowedForDeckSize(37), 7);
  assert.equal(peeksAllowedForDeckSize(4), 0);
  assert.equal(peeksAllowedForDeckSize(0), 0);
});
