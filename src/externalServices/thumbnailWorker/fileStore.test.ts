import assert from 'node:assert/strict';
import test from 'node:test';
import {assertSafeFileName} from './fileStore.js';

test('thumbnail worker accepts bounded cache file names', () => {
  assert.doesNotThrow(() => assertSafeFileName('level_7295_LARGE.png', '.png'));
  assert.doesNotThrow(() => assertSafeFileName('level_7295_LARGE.html', '.html'));
});

test('thumbnail worker rejects traversal and wrong extensions', () => {
  assert.throws(() => assertSafeFileName('../secret.png', '.png'));
  assert.throws(() => assertSafeFileName('/tmp/result.png', '.png'));
  assert.throws(() => assertSafeFileName('result.html', '.png'));
  assert.throws(() => assertSafeFileName('nested/result.png', '.png'));
});
