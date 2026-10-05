import assert from 'node:assert/strict';
import test from 'node:test';

import {
  precedesFilter,
  reverseEsSort,
  sortKeysFromEsSort,
} from './leaderboardAroundQuery.js';

void test('sortKeysFromEsSort reads shorthand and object orders', () => {
  assert.deepEqual(
    sortKeysFromEsSort([{ rankedScore: 'desc' }, { id: { order: 'desc' } }]),
    [
      { field: 'rankedScore', order: 'desc' },
      { field: 'id', order: 'desc' },
    ],
  );
});

void test('reverseEsSort flips every key and keeps extra sort options', () => {
  assert.deepEqual(
    reverseEsSort([{ rankedScore: 'desc' }, { id: { order: 'desc', missing: '_last' } }]),
    [{ rankedScore: 'asc' }, { id: { order: 'asc', missing: '_last' } }],
  );
});

void test('precedesFilter matches a descending score with an id tiebreak', () => {
  assert.deepEqual(
    precedesFilter(
      [
        { field: 'rankedScore', order: 'desc' },
        { field: 'id', order: 'desc' },
      ],
      [1000, 42],
    ),
    {
      bool: {
        should: [
          { bool: { filter: [{ range: { rankedScore: { gt: 1000 } } }] } },
          {
            bool: {
              filter: [
                { range: { rankedScore: { gte: 1000, lte: 1000 } } },
                { range: { id: { gt: 42 } } },
              ],
            },
          },
        ],
        minimum_should_match: 1,
      },
    },
  );
});

void test('precedesFilter walks a three-key sort', () => {
  const filter = precedesFilter(
    [
      { field: 'topDiffSortOrder', order: 'desc' },
      { field: 'rankedScore', order: 'desc' },
      { field: 'id', order: 'desc' },
    ],
    [3, 50, 9],
  );
  const should = (filter as { bool: { should: unknown[] } }).bool.should;
  assert.equal(should.length, 3);
});

void test('precedesFilter treats a missing anchor value as sorting last', () => {
  assert.deepEqual(
    precedesFilter([{ field: 'name.lower', order: 'asc' }], [null]),
    {
      bool: {
        should: [{ bool: { filter: [{ exists: { field: 'name.lower' } }] } }],
        minimum_should_match: 1,
      },
    },
  );
});

void test('precedesFilter uses a less-than range for ascending strings', () => {
  assert.deepEqual(
    precedesFilter(
      [
        { field: 'name.lower', order: 'asc' },
        { field: 'id', order: 'desc' },
      ],
      ['nova', 7],
    ),
    {
      bool: {
        should: [
          { bool: { filter: [{ range: { 'name.lower': { lt: 'nova' } } }] } },
          {
            bool: {
              filter: [
                { term: { 'name.lower': 'nova' } },
                { range: { id: { gt: 7 } } },
              ],
            },
          },
        ],
        minimum_should_match: 1,
      },
    },
  );
});
