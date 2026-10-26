import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTOMATIC_LEVEL_TAG_NAMES, isAutomaticLevelTagName } from './automaticLevelTags.js';

test('parser-derived tags are recognized by name', () => {
  assert.equal(isAutomaticLevelTagName('Full VFX'), true);
  assert.equal(isAutomaticLevelTagName('Timeless'), true);
  assert.equal(isAutomaticLevelTagName('DLC'), true);
  assert.equal(isAutomaticLevelTagName('Auto Tile'), true);
  assert.equal(isAutomaticLevelTagName('Memory'), false);
  assert.equal(isAutomaticLevelTagName(''), false);
  assert.equal(isAutomaticLevelTagName(null), false);
});

test('automatic tag names are unique', () => {
  const listed = [...AUTOMATIC_LEVEL_TAG_NAMES];
  assert.equal(new Set(listed).size, listed.length);
  assert.ok(listed.length > 0);
});
