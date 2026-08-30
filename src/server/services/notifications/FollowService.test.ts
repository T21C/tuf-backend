import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  followFanoutNotifyFilter,
  isFollowNotifyLevel,
  parseFollowingFilterMode,
  parseFollowingQueryParam,
} from './FollowService.js';

test('follow fan-out only includes notifyLevel all', () => {
  assert.deepEqual(followFanoutNotifyFilter(), {notifyLevel: 'all'});
});

test('isFollowNotifyLevel accepts all and none', () => {
  assert.equal(isFollowNotifyLevel('all'), true);
  assert.equal(isFollowNotifyLevel('none'), true);
  assert.equal(isFollowNotifyLevel('silent'), false);
});

test('parseFollowingFilterMode maps only/true/1 and hide', () => {
  assert.equal(parseFollowingFilterMode('only'), 'only');
  assert.equal(parseFollowingFilterMode('true'), 'only');
  assert.equal(parseFollowingFilterMode('1'), 'only');
  assert.equal(parseFollowingFilterMode('hide'), 'hide');
  assert.equal(parseFollowingFilterMode('show'), 'show');
  assert.equal(parseFollowingFilterMode(undefined), 'show');
});

test('parseFollowingQueryParam is true for only and hide', () => {
  assert.equal(parseFollowingQueryParam('true'), true);
  assert.equal(parseFollowingQueryParam('ONLY'), true);
  assert.equal(parseFollowingQueryParam('hide'), true);
  assert.equal(parseFollowingQueryParam(undefined), false);
  assert.equal(parseFollowingQueryParam('show'), false);
  assert.equal(parseFollowingQueryParam('false'), false);
});
