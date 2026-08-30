import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  followFanoutNotifyFilter,
  isFollowNotifyLevel,
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

test('parseFollowingQueryParam accepts true and 1', () => {
  assert.equal(parseFollowingQueryParam('true'), true);
  assert.equal(parseFollowingQueryParam('TRUE'), true);
  assert.equal(parseFollowingQueryParam('1'), true);
  assert.equal(parseFollowingQueryParam(1), true);
  assert.equal(parseFollowingQueryParam(true), true);
});

test('parseFollowingQueryParam rejects other values', () => {
  assert.equal(parseFollowingQueryParam(undefined), false);
  assert.equal(parseFollowingQueryParam(null), false);
  assert.equal(parseFollowingQueryParam(''), false);
  assert.equal(parseFollowingQueryParam('false'), false);
  assert.equal(parseFollowingQueryParam('0'), false);
  assert.equal(parseFollowingQueryParam('yes'), false);
});
