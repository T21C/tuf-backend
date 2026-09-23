import assert from 'node:assert/strict';
import test from 'node:test';

import {BOT_MOD_DIFF, decideBotModLinkAction, snapshotVersion} from './botModDiff.js';

const base = {
  enabled: true,
  ignoreUpdate: false,
  missing: false,
  version: '1.2.0',
  parsedDownload: 'https://github.com/org/mod/releases/download/1.2.0/mod.zip',
  lastAppliedVersion: '1.2.0',
  lastAppliedDownloadUrl: 'https://github.com/org/mod/releases/download/1.2.0/mod.zip',
  catalogHasVersion: true,
};

void test('snapshotVersion trims and caps length', () => {
  assert.equal(snapshotVersion('  1.0.0  '), '1.0.0');
  assert.equal(snapshotVersion(null), '');
  assert.equal(snapshotVersion('x'.repeat(80)).length, 64);
});

void test('same version and url is a no-op', () => {
  assert.equal(decideBotModLinkAction(base).kind, BOT_MOD_DIFF.NOOP);
});

void test('same version with a new download url advances the cursor only', () => {
  assert.equal(
    decideBotModLinkAction({
      ...base,
      parsedDownload: 'https://github.com/org/mod/releases/download/1.2.0/mod-rebuild.zip',
    }).kind,
    BOT_MOD_DIFF.ADVANCE_URL,
  );
});

void test('new version creates a release when the catalog does not already have it', () => {
  assert.equal(
    decideBotModLinkAction({
      ...base,
      version: '1.3.0',
      parsedDownload: 'https://github.com/org/mod/releases/download/1.3.0/mod.zip',
      catalogHasVersion: false,
    }).kind,
    BOT_MOD_DIFF.CREATE_RELEASE,
  );
});

void test('new version that already exists on the catalog is skipped', () => {
  assert.equal(
    decideBotModLinkAction({
      ...base,
      version: '1.3.0',
      catalogHasVersion: true,
    }).kind,
    BOT_MOD_DIFF.SKIP_EXISTING,
  );
});

void test('empty version is an error', () => {
  assert.equal(decideBotModLinkAction({...base, version: '   '}).kind, BOT_MOD_DIFF.EMPTY_VERSION);
  assert.equal(decideBotModLinkAction({...base, version: null}).kind, BOT_MOD_DIFF.EMPTY_VERSION);
});

void test('missing download url is an error', () => {
  assert.equal(
    decideBotModLinkAction({...base, parsedDownload: '  '}).kind,
    BOT_MOD_DIFF.MISSING_DOWNLOAD,
  );
});

void test('ignoreUpdate skips applying', () => {
  assert.equal(
    decideBotModLinkAction({...base, ignoreUpdate: true, version: '9.9.9'}).kind,
    BOT_MOD_DIFF.IGNORE_UPDATE,
  );
});

void test('disabled and missing rows are not applied', () => {
  assert.equal(decideBotModLinkAction({...base, enabled: false}).kind, BOT_MOD_DIFF.DISABLED);
  assert.equal(decideBotModLinkAction({...base, missing: true, version: '9.9.9'}).kind, BOT_MOD_DIFF.MISSING);
});

void test('cursor matching a version the catalog does not have creates a release', () => {
  assert.equal(
    decideBotModLinkAction({
      ...base,
      catalogHasVersion: false,
    }).kind,
    BOT_MOD_DIFF.CREATE_RELEASE,
  );
});

void test('first version after linking an empty snapshot creates a release', () => {
  assert.equal(
    decideBotModLinkAction({
      ...base,
      lastAppliedVersion: null,
      lastAppliedDownloadUrl: null,
      version: '1.0.0',
      catalogHasVersion: false,
    }).kind,
    BOT_MOD_DIFF.CREATE_RELEASE,
  );
});
