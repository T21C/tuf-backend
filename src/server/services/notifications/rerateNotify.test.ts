import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isTrackedRerate} from './rerateNotify.js';

test('isTrackedRerate requires two different ranked difficulties', () => {
  assert.equal(isTrackedRerate(4, 9), true);
  assert.equal(isTrackedRerate('4', '9'), true);
  assert.equal(isTrackedRerate(4, 4), false);
  assert.equal(isTrackedRerate(0, 9), false);
  assert.equal(isTrackedRerate(4, 0), false);
  assert.equal(isTrackedRerate(null, 9), false);
  assert.equal(isTrackedRerate(4, undefined), false);
});
