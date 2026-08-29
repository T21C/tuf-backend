import assert from 'node:assert/strict';
import test from 'node:test';

import {CDC_WATCHED_TABLES} from './constants.js';

void test('CDC watches mods and assignee tables', () => {
  assert.equal(CDC_WATCHED_TABLES.includes('mods'), true);
  assert.equal(CDC_WATCHED_TABLES.includes('mod_assignees'), true);
});
