import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldDropPushSubscription,
  shouldSendPush,
} from './pushDispatchPolicy.js';

test('dispatcher skips when push is disabled, in-app is muted, or cap is exceeded', () => {
  const base = {
    pushAvailable: true,
    pushEnabled: true,
    inApp: true,
    categoryInApp: true,
    overHourlyCap: false,
  };
  assert.equal(shouldSendPush(base), true);
  assert.equal(shouldSendPush({...base, pushEnabled: false}), false);
  assert.equal(shouldSendPush({...base, inApp: false}), false);
  assert.equal(shouldSendPush({...base, categoryInApp: false}), false);
  assert.equal(shouldSendPush({...base, overHourlyCap: true}), false);
  assert.equal(shouldSendPush({...base, pushAvailable: false}), false);
});

test('410 and 404 drop the push subscription', () => {
  assert.equal(shouldDropPushSubscription(410), true);
  assert.equal(shouldDropPushSubscription(404), true);
  assert.equal(shouldDropPushSubscription(500), false);
  assert.equal(shouldDropPushSubscription(undefined), false);
});
