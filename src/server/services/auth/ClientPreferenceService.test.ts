import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_PREFERENCE_KEYS,
  ClientPreferenceError,
  mergeClientPreferences,
  normalizeStoredClientPreferences,
  sanitizeClientPreferencePatch,
} from './clientPreferencePayload.js';

test('sanitize rejects non-objects', () => {
  assert.throws(() => sanitizeClientPreferencePatch(null), ClientPreferenceError);
  assert.throws(() => sanitizeClientPreferencePatch([]), ClientPreferenceError);
  assert.throws(() => sanitizeClientPreferencePatch('x'), ClientPreferenceError);
});

test('sanitize rejects unknown keys', () => {
  assert.throws(
    () => sanitizeClientPreferencePatch({nope: true}),
    (err: unknown) => err instanceof ClientPreferenceError && /Unknown preference key/.test(err.message),
  );
});

test('sanitize accepts empty object', () => {
  assert.deepEqual(sanitizeClientPreferencePatch({}), {});
});

test('sticky true keys ignore false and keep true', () => {
  const patch = sanitizeClientPreferencePatch({
    [CLIENT_PREFERENCE_KEYS.HOME_RESOURCES_CTA_DISMISSED]: false,
    [CLIENT_PREFERENCE_KEYS.INBOX_PUSH_NUDGE_DISMISSED]: true,
  });
  assert.deepEqual(patch, {
    [CLIENT_PREFERENCE_KEYS.INBOX_PUSH_NUDGE_DISMISSED]: true,
  });
});

test('merge keeps sticky true even if patch omits it', () => {
  const merged = mergeClientPreferences(
    {[CLIENT_PREFERENCE_KEYS.HOME_RESOURCES_CTA_DISMISSED]: true},
    {[CLIENT_PREFERENCE_KEYS.SUBMISSION_MINIMAL_MOTION]: true},
  );
  assert.equal(merged[CLIENT_PREFERENCE_KEYS.HOME_RESOURCES_CTA_DISMISSED], true);
  assert.equal(merged[CLIENT_PREFERENCE_KEYS.SUBMISSION_MINIMAL_MOTION], true);
});

test('mods start guide cta sticky key is accepted', () => {
  const patch = sanitizeClientPreferencePatch({
    [CLIENT_PREFERENCE_KEYS.MODS_START_GUIDE_CTA_DISMISSED]: true,
  });
  assert.equal(patch[CLIENT_PREFERENCE_KEYS.MODS_START_GUIDE_CTA_DISMISSED], true);
  const ignored = sanitizeClientPreferencePatch({
    [CLIENT_PREFERENCE_KEYS.MODS_START_GUIDE_CTA_DISMISSED]: false,
  });
  assert.deepEqual(ignored, {});
});

test('tufhelperlite.neverShow is writable both ways', () => {
  const on = sanitizeClientPreferencePatch({
    [CLIENT_PREFERENCE_KEYS.TUFHELPERLITE_NEVER_SHOW]: true,
  });
  const off = sanitizeClientPreferencePatch({
    [CLIENT_PREFERENCE_KEYS.TUFHELPERLITE_NEVER_SHOW]: false,
  });
  assert.equal(on[CLIENT_PREFERENCE_KEYS.TUFHELPERLITE_NEVER_SHOW], true);
  assert.equal(off[CLIENT_PREFERENCE_KEYS.TUFHELPERLITE_NEVER_SHOW], false);
  const merged = mergeClientPreferences(on, off);
  assert.equal(merged[CLIENT_PREFERENCE_KEYS.TUFHELPERLITE_NEVER_SHOW], false);
});

test('appLanguage normalizes us to en and rejects unknown codes', () => {
  const patch = sanitizeClientPreferencePatch({appLanguage: 'US'});
  assert.equal(patch.appLanguage, 'en');
  assert.throws(
    () => sanitizeClientPreferencePatch({appLanguage: 'zz'}),
    ClientPreferenceError,
  );
});

test('dropdownClickMode only allows cycle or pin', () => {
  assert.equal(
    sanitizeClientPreferencePatch({
      [CLIENT_PREFERENCE_KEYS.NAV_DROPDOWN_CLICK_MODE]: 'pin',
    })[CLIENT_PREFERENCE_KEYS.NAV_DROPDOWN_CLICK_MODE],
    'pin',
  );
  assert.throws(
    () => sanitizeClientPreferencePatch({
      [CLIENT_PREFERENCE_KEYS.NAV_DROPDOWN_CLICK_MODE]: 'hover',
    }),
    ClientPreferenceError,
  );
});

test('hidden tag ids are unique finite numbers', () => {
  const patch = sanitizeClientPreferencePatch({
    [CLIENT_PREFERENCE_KEYS.DISPLAY_HIDDEN_LEVEL_CARD_TAG_IDS]: [1, '2', 1, 3],
  });
  assert.deepEqual(patch[CLIENT_PREFERENCE_KEYS.DISPLAY_HIDDEN_LEVEL_CARD_TAG_IDS], [1, 2, 3]);
  assert.throws(
    () => sanitizeClientPreferencePatch({
      [CLIENT_PREFERENCE_KEYS.DISPLAY_HIDDEN_LEVEL_CARD_TAG_IDS]: '1,2',
    }),
    ClientPreferenceError,
  );
});

test('writable bools replace', () => {
  const merged = mergeClientPreferences(
    {[CLIENT_PREFERENCE_KEYS.SUBMISSION_DISABLE_MASCOTS]: true},
    {[CLIENT_PREFERENCE_KEYS.SUBMISSION_DISABLE_MASCOTS]: false},
  );
  assert.equal(merged[CLIENT_PREFERENCE_KEYS.SUBMISSION_DISABLE_MASCOTS], false);
});

test('normalizeStored drops junk keys', () => {
  const cleaned = normalizeStoredClientPreferences({
    nope: true,
    [CLIENT_PREFERENCE_KEYS.APP_LANGUAGE]: 'kr',
    [CLIENT_PREFERENCE_KEYS.HOME_RESOURCES_CTA_DISMISSED]: false,
  });
  assert.deepEqual(cleaned, {[CLIENT_PREFERENCE_KEYS.APP_LANGUAGE]: 'kr'});
});

test('normalizeStored keeps valid keys when another value is invalid', () => {
  const cleaned = normalizeStoredClientPreferences({
    [CLIENT_PREFERENCE_KEYS.APP_LANGUAGE]: 'zz',
    [CLIENT_PREFERENCE_KEYS.SUBMISSION_DISABLE_MASCOTS]: true,
  });
  assert.deepEqual(cleaned, {
    [CLIENT_PREFERENCE_KEYS.SUBMISSION_DISABLE_MASCOTS]: true,
  });
});
