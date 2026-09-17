import assert from 'node:assert/strict';
import test from 'node:test';
import { isWeeklyLevelPublic } from './weeklyLevelVisibility.js';

test('isWeeklyLevelPublic rejects missing, deleted, and hidden levels', () => {
  assert.equal(isWeeklyLevelPublic(null), false);
  assert.equal(isWeeklyLevelPublic(undefined), false);
  assert.equal(isWeeklyLevelPublic({ isDeleted: true, isHidden: false }), false);
  assert.equal(isWeeklyLevelPublic({ isDeleted: false, isHidden: true }), false);
  assert.equal(isWeeklyLevelPublic({ isDeleted: true, isHidden: true }), false);
});

test('isWeeklyLevelPublic accepts a live public level', () => {
  assert.equal(isWeeklyLevelPublic({ isDeleted: false, isHidden: false }), true);
});
