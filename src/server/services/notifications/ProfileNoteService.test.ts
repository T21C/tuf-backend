import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  PROFILE_NOTE_MAX_LENGTH,
  isProfileNoteTargetType,
  parseProfileNoteText,
} from './ProfileNoteService.js';

test('isProfileNoteTargetType accepts player and creator', () => {
  assert.equal(isProfileNoteTargetType('player'), true);
  assert.equal(isProfileNoteTargetType('creator'), true);
  assert.equal(isProfileNoteTargetType('user'), false);
});

test('parseProfileNoteText rejects non-strings', () => {
  assert.deepEqual(parseProfileNoteText(null), {
    ok: false,
    error: 'text must be a string',
    status: 400,
  });
  assert.equal(parseProfileNoteText(1).ok, false);
});

test('parseProfileNoteText treats blank as delete', () => {
  assert.deepEqual(parseProfileNoteText(''), {ok: true, text: null});
  assert.deepEqual(parseProfileNoteText('   \n\t  '), {ok: true, text: null});
});

test('parseProfileNoteText trims ends and keeps inner whitespace', () => {
  assert.deepEqual(parseProfileNoteText('  hello\nthere  '), {ok: true, text: 'hello\nthere'});
});

test('parseProfileNoteText rejects over-limit without slicing', () => {
  const tooLong = 'a'.repeat(PROFILE_NOTE_MAX_LENGTH + 1);
  const result = parseProfileNoteText(tooLong);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.match(result.error, /2000/);
  }
  assert.equal(tooLong.length, PROFILE_NOTE_MAX_LENGTH + 1);
});

test('parseProfileNoteText accepts max length', () => {
  const max = 'b'.repeat(PROFILE_NOTE_MAX_LENGTH);
  assert.deepEqual(parseProfileNoteText(max), {ok: true, text: max});
});
