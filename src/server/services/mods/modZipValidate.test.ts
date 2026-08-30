import assert from 'node:assert/strict';
import test from 'node:test';

import {MOD_ZIP_MAX_BYTES, MOD_ZIP_MAX_ENTRY_COUNT} from './modZipLimits.js';
import {
  archiveEntryPathIsUnsafe,
  assertModZipEntriesSafe,
  assertModZipFilename,
  assertModZipSize,
  displayNameFromModZipMetadata,
  hasZipMagic,
  isModReleaseSourceLocked,
  isZipFilename,
  sanitiseModZipStorageName,
} from './modZipValidate.js';

void test('isZipFilename requires a .zip suffix', () => {
  assert.equal(isZipFilename('mod.zip'), true);
  assert.equal(isZipFilename('Mod.ZIP'), true);
  assert.equal(isZipFilename('mod.tar.gz'), false);
  assert.equal(isZipFilename('mod'), false);
});

void test('assertModZipFilename rejects non-zip names', () => {
  assert.doesNotThrow(() => assertModZipFilename('pack.zip'));
  assert.throws(() => assertModZipFilename('pack.rar'));
});

void test('assertModZipSize rejects empty and oversized archives', () => {
  assert.doesNotThrow(() => assertModZipSize(1));
  assert.doesNotThrow(() => assertModZipSize(MOD_ZIP_MAX_BYTES));
  assert.throws(() => assertModZipSize(0));
  assert.throws(() => assertModZipSize(MOD_ZIP_MAX_BYTES + 1));
});

void test('hasZipMagic accepts local, empty, and spanned PK signatures', () => {
  assert.equal(hasZipMagic(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])), true);
  assert.equal(hasZipMagic(new Uint8Array([0x50, 0x4b, 0x05, 0x06])), true);
  assert.equal(hasZipMagic(new Uint8Array([0x50, 0x4b, 0x07, 0x08])), true);
  assert.equal(hasZipMagic(new Uint8Array([0x50, 0x4b, 0x01, 0x02])), false);
  assert.equal(hasZipMagic(new Uint8Array([0x3c, 0x68, 0x74, 0x6d])), false);
  assert.equal(hasZipMagic(new Uint8Array([0x50, 0x4b])), false);
});

void test('archiveEntryPathIsUnsafe rejects traversal and absolute paths', () => {
  assert.equal(archiveEntryPathIsUnsafe('mod.dll'), false);
  assert.equal(archiveEntryPathIsUnsafe('folder/mod.dll'), false);
  assert.equal(archiveEntryPathIsUnsafe('../secret'), true);
  assert.equal(archiveEntryPathIsUnsafe('a/../../b'), true);
  assert.equal(archiveEntryPathIsUnsafe('a\\..\\b'), true);
  assert.equal(archiveEntryPathIsUnsafe('/etc/passwd'), true);
  assert.equal(archiveEntryPathIsUnsafe(''), true);
});

void test('assertModZipEntriesSafe rejects empty archives, traversal, and bomb sizes', () => {
  assert.doesNotThrow(() =>
    assertModZipEntriesSafe([{relativePath: 'a.dll', size: 10, isDirectory: false}], 10),
  );
  assert.throws(() => assertModZipEntriesSafe([], 10));
  assert.throws(() =>
    assertModZipEntriesSafe([{relativePath: '../x', size: 10, isDirectory: false}], 10),
  );
  const tooMany = Array.from({length: MOD_ZIP_MAX_ENTRY_COUNT + 1}, (_, i) => ({
    relativePath: `f${i}.txt`,
    size: 1,
    isDirectory: false,
  }));
  assert.throws(() => assertModZipEntriesSafe(tooMany, tooMany.length));
});

void test('sanitiseModZipStorageName keeps the uploaded basename', () => {
  assert.equal(sanitiseModZipStorageName('Litematica-0.1.0.zip'), 'Litematica-0.1.0.zip');
  assert.equal(sanitiseModZipStorageName('uploads/My Mod.zip'), 'My Mod.zip');
  assert.equal(sanitiseModZipStorageName('../secret.zip'), 'secret.zip');
  assert.equal(sanitiseModZipStorageName('notes.txt'), 'mod.zip');
  assert.equal(sanitiseModZipStorageName('.zip'), 'mod.zip');
  assert.equal(sanitiseModZipStorageName('a<b>.zip'), 'a_b_.zip');
});

void test('displayNameFromModZipMetadata prefers originalFilename', () => {
  assert.equal(
    displayNameFromModZipMetadata({
      originalZip: {name: 'original.zip', originalFilename: 'AdofaiTweaks.zip'},
    }),
    'AdofaiTweaks.zip',
  );
  assert.equal(displayNameFromModZipMetadata({originalZip: {name: 'pack.zip'}}), 'pack.zip');
  assert.equal(displayNameFromModZipMetadata(null), null);
});

void test('hosted zip releases lock their source', () => {
  assert.equal(isModReleaseSourceLocked('hosted'), true);
  assert.equal(isModReleaseSourceLocked('github'), false);
  assert.equal(isModReleaseSourceLocked('external'), false);
});
