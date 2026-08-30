import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildModSearchQuery,
  buildModSearchSort,
  buildModTextShould,
  parseModLimit,
  parseModOffset,
  parseModSort,
} from './modSearchQuery.js';

void test('buildModTextShould is query-only and does not use env', () => {
  const should = buildModTextShould('v0w4n');
  assert.ok(should.length > 0);
  const asJson = JSON.stringify(should);
  assert.equal(asJson.includes('process.env'), false);
  assert.equal(asJson.includes('v0w4n'), true);
});

void test('buildModTextShould escapes wildcard metacharacters', () => {
  const asJson = JSON.stringify(buildModTextShould('a*b?c\\d'));
  assert.equal(asJson.includes('process.env'), false);
  assert.equal(asJson.includes('*a\\\\*b\\\\?c\\\\\\\\d*'), true);
});

void test('buildModSearchQuery filters hidden for public and match_all when empty', () => {
  const empty = buildModSearchQuery({});
  assert.deepEqual(empty, {
    bool: {filter: [{term: {hidden: false}}]},
  });

  const adminEmpty = buildModSearchQuery({includeHidden: true});
  assert.deepEqual(adminEmpty, {match_all: {}});

  const searched = buildModSearchQuery({q: 'alice'});
  assert.equal((searched as {bool: {minimum_should_match: number}}).bool.minimum_should_match, 1);
  assert.equal(JSON.stringify(searched).includes('process.env'), false);
});

void test('parseModOffset and parseModLimit use numeric defaults without env', () => {
  assert.equal(parseModOffset(undefined), 0);
  assert.equal(parseModOffset('-4'), 0);
  assert.equal(parseModOffset('45'), 45);
  assert.equal(parseModLimit(undefined), 30);
  assert.equal(parseModLimit('0'), 1);
  assert.equal(parseModLimit('500'), 100);
  assert.equal(parseModSort('date-desc'), 'date-desc');
  assert.equal(parseModSort('nope'), 'date-desc');
});

void test('buildModSearchSort pins first then requested sort without env', () => {
  const sort = buildModSearchSort('creator-asc');
  const asJson = JSON.stringify(sort);
  assert.equal(asJson.includes('process.env'), false);
  assert.equal(asJson.includes('isPinned'), true);
  assert.equal(asJson.includes('creatorSortKey'), true);
  const newest = JSON.stringify(buildModSearchSort());
  assert.equal(newest.includes('sourceUploadedAt'), true);
});

void test('buildModSearchQuery applies tag facet filters', () => {
  const queried = buildModSearchQuery({
    facetQueryV1: {
      v: 1,
      tags: {mode: 'simple', op: 'or', ids: [3, 5]},
    },
  });
  const asJson = JSON.stringify(queried);
  assert.equal(asJson.includes('tags.id'), true);
  assert.equal(asJson.includes('hidden'), true);
  assert.equal(asJson.includes('process.env'), false);
});
