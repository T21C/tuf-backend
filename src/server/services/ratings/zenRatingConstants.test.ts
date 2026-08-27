import assert from 'node:assert/strict';
import test from 'node:test';
import { parseZenIncludeBands } from './zenRatingConstants.js';

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
