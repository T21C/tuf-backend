import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  followFanoutNotifyFilter,
  isFollowNotifyLevel,
} from './FollowService.js';

test('follow fan-out only includes notifyLevel all', () => {
  assert.deepEqual(followFanoutNotifyFilter(), {notifyLevel: 'all'});
});

test('isFollowNotifyLevel accepts all and none', () => {
  assert.equal(isFollowNotifyLevel('all'), true);
  assert.equal(isFollowNotifyLevel('none'), true);
  assert.equal(isFollowNotifyLevel('silent'), false);
});
