import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clipDiscordDescription,
  DISCORD_DESCRIPTION_MAX,
  LARGE_TEXT_MAX,
  parseLargeText,
} from './textLimits.js';

void test('parseLargeText trims and accepts prose at the shared cap', () => {
  assert.deepEqual(parseLargeText('  hello  '), {ok: true, value: 'hello'});
  assert.equal(parseLargeText('x'.repeat(LARGE_TEXT_MAX)).ok, true);
});

void test('parseLargeText rejects overflow and required blanks', () => {
  const tooLong = parseLargeText('x'.repeat(LARGE_TEXT_MAX + 1), {label: 'Reason'});
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) {
    assert.equal(tooLong.code, 'length');
    assert.equal(tooLong.max, LARGE_TEXT_MAX);
    assert.match(tooLong.message, /Reason/);
  }
  const missing = parseLargeText('   ', {required: true, label: 'Reason'});
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, 'required');
});

void test('clipDiscordDescription stays within the embed cap', () => {
  assert.equal(clipDiscordDescription('ok'), 'ok');
  assert.equal(
    clipDiscordDescription('n'.repeat(DISCORD_DESCRIPTION_MAX + 20)).length,
    DISCORD_DESCRIPTION_MAX,
  );
});
