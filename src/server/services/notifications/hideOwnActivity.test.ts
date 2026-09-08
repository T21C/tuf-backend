import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shouldHideOwnActivityNotification} from './hideOwnActivity.js';

test('does not hide when the setting is off or missing', () => {
  assert.equal(
    shouldHideOwnActivityNotification({
      actorId: 'user-1',
      userId: 'user-1',
      hideOwnActivity: false,
    }),
    false,
  );
  assert.equal(
    shouldHideOwnActivityNotification({
      actorId: 'user-1',
      userId: 'user-1',
    }),
    false,
  );
});

test('hides when the recipient is the actor and the setting is on', () => {
  assert.equal(
    shouldHideOwnActivityNotification({
      actorId: 'user-1',
      userId: 'user-1',
      hideOwnActivity: true,
    }),
    true,
  );
});

test('does not hide for a different user or missing actor', () => {
  assert.equal(
    shouldHideOwnActivityNotification({
      actorId: 'user-1',
      userId: 'user-2',
      hideOwnActivity: true,
    }),
    false,
  );
  assert.equal(
    shouldHideOwnActivityNotification({
      actorId: null,
      userId: 'user-1',
      hideOwnActivity: true,
    }),
    false,
  );
});
