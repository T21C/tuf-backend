import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CURATION_RATING_LIST_PAGE_SIZE,
  parseCurationQueueCommaIds,
  parseCurationRatingListQuery,
} from './curationRatingListQuery.js';

test('parseCurationQueueCommaIds keeps positive integer lists', () => {
  assert.deepEqual(parseCurationQueueCommaIds('1686, 12,1686'), [1686, 12, 1686]);
  assert.equal(parseCurationQueueCommaIds('1686'), null);
  assert.equal(parseCurationQueueCommaIds('song name'), null);
  assert.equal(parseCurationQueueCommaIds('12,foo'), null);
});

test('parseCurationRatingListQuery defaults and clamps list params', () => {
  assert.deepEqual(parseCurationRatingListQuery({}, null), {
    offset: 0,
    limit: CURATION_RATING_LIST_PAGE_SIZE,
    query: '',
    sort: 'ratings',
    order: 'ASC',
    myRated: 'show',
    flow: null,
    vote: 'include',
    userId: null,
  });
  const parsed = parseCurationRatingListQuery(
    {
      offset: '30',
      limit: '500',
      query: '  rocky  ',
      sort: 'id',
      order: 'desc',
      myRated: 'hide',
      flow: 'RERATE',
      vote: 'only',
    },
    'user-1',
  );
  assert.equal(parsed.offset, 30);
  assert.equal(parsed.limit, 100);
  assert.equal(parsed.query, 'rocky');
  assert.equal(parsed.sort, 'id');
  assert.equal(parsed.order, 'DESC');
  assert.equal(parsed.myRated, 'hide');
  assert.equal(parsed.flow, 'rerate');
  assert.equal(parsed.vote, 'only');
  assert.equal(parsed.userId, 'user-1');
});
