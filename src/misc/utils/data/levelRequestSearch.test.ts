import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchRequestStatuses,
  matchRequestTypes,
  parseLevelRequestSearchQuery,
  parsePositiveSearchInt,
  requestSearchHasStatusField,
  rewriteRequestSearchTerm,
} from './levelRequestSearch.js';

test('request search rewrites #id and field aliases', () => {
  assert.deepEqual(
    rewriteRequestSearchTerm({field: 'any', value: '#42', exact: false, isNot: false}),
    {field: 'level', value: '42', exact: true, isNot: false},
  );
  assert.deepEqual(
    rewriteRequestSearchTerm({field: 'levelid', value: '#9', exact: false, isNot: true}),
    {field: 'level', value: '9', exact: false, isNot: true},
  );
  assert.deepEqual(
    rewriteRequestSearchTerm({field: 'username', value: 'v0w4n', exact: true, isNot: false}),
    {field: 'requester', value: 'v0w4n', exact: true, isNot: false},
  );
  assert.equal(parsePositiveSearchInt('#12'), null);
  assert.equal(parsePositiveSearchInt('12'), 12);
});

test('request search parses operators into AND groups and OR groups', () => {
  const groups = parseLevelRequestSearchQuery('song:hello, requester:v0w4n | status=pending');
  assert.equal(groups.length, 2);
  assert.equal(groups[0].terms.length, 2);
  assert.equal(groups[0].terms[0].field, 'song');
  assert.equal(groups[0].terms[0].exact, false);
  assert.equal(groups[0].terms[1].field, 'requester');
  assert.equal(groups[1].terms[0].field, 'status');
  assert.equal(groups[1].terms[0].exact, true);
  assert.equal(requestSearchHasStatusField(groups), true);
  assert.equal(requestSearchHasStatusField(parseLevelRequestSearchQuery('song:hello')), false);
});

test('request search matches status and type tokens', () => {
  assert.deepEqual(matchRequestStatuses('pending', true), ['pending']);
  assert.deepEqual(matchRequestStatuses('complete', false), [
    'completed',
    'completed_changed',
    'completed_unchanged',
  ]);
  assert.deepEqual(matchRequestStatuses('discord', true), ['discord_vote']);
  assert.deepEqual(matchRequestTypes('info', true), ['info_change']);
  assert.deepEqual(matchRequestTypes('curation', false), ['curation', 'curation_rerate']);
  assert.deepEqual(matchRequestTypes('rerate', true), ['rerate']);
});
