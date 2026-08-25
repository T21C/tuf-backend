import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isOverPushHourlyCap} from './pushHourlyCap.js';

test('hourly cap is exceeded after 10', () => {
  assert.equal(isOverPushHourlyCap(10), false);
  assert.equal(isOverPushHourlyCap(11), true);
});
