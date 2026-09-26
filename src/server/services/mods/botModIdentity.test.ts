import assert from 'node:assert/strict';
import test from 'node:test';

import {botModIdFromName, groupFeedMods, type BotModFeedRow} from './botModIdentity.js';

const EZ2FAI_ID = '00557de6d093fecbf85e67ae19f8d18c653547ea4b913f56951acc649781a4ed';

function row(patch: Partial<BotModFeedRow> & Pick<BotModFeedRow, 'name'>): BotModFeedRow {
  const seen = new Date('2026-01-01T00:00:00Z');
  return {
    id: 'feed-upload',
    sourceMongoId: null,
    version: '1.0.0',
    parsedDownload: 'https://example.com/mod.zip',
    download: 'https://example.com/mod.zip',
    description: 'notes',
    cachedUsername: 'author',
    creatorDiscordId: '1',
    uploadedAt: seen,
    ignoreUpdate: false,
    hideFromSearch: false,
    lastSeenAt: seen,
    missingSince: null,
    updatedAt: seen,
    ...patch,
  };
}

void test('bot mod id is a stable hash of the name', () => {
  assert.equal(botModIdFromName('EZ2FAI'), EZ2FAI_ID);
  assert.equal(botModIdFromName('EZ2FAI'), botModIdFromName('EZ2FAI'));
  assert.notEqual(botModIdFromName('EZ2FAI'), botModIdFromName('EZ2FAI '));
});

void test('uploads that share a name are one mod and one release per version', () => {
  const grouped = groupFeedMods([
    row({
      name: 'EZ2FAI',
      version: '2.2.0',
      parsedDownload: 'https://example.com/2.2.0.zip',
      uploadedAt: new Date('2025-03-01T00:00:00Z'),
      ignoreUpdate: true,
    }),
    row({
      name: 'EZ2FAI',
      version: '2.3.0',
      parsedDownload: 'https://example.com/2.3.0.zip',
      uploadedAt: new Date('2025-05-01T00:00:00Z'),
      ignoreUpdate: false,
      cachedUsername: 'leo',
    }),
    row({
      name: 'Other',
      version: '1.0.0',
    }),
  ]);

  assert.equal(grouped.length, 2);
  const ez = grouped.find((item) => item.name === 'EZ2FAI');
  assert.ok(ez);
  assert.equal(ez.id, EZ2FAI_ID);
  assert.equal(ez.version, '2.3.0');
  assert.equal(ez.ignoreUpdate, false);
  assert.equal(ez.cachedUsername, 'leo');
  assert.deepEqual(
    ez.releases.map((release) => release.version),
    ['2.2.0', '2.3.0'],
  );
  assert.equal(ez.releases[0]?.parsedDownload, 'https://example.com/2.2.0.zip');
  assert.equal(ez.releases[1]?.botId, EZ2FAI_ID);
});

void test('a newer upload of the same version replaces the download url', () => {
  const grouped = groupFeedMods([
    row({
      name: 'EZ2FAI',
      version: '2.3.0',
      parsedDownload: 'https://example.com/old.zip',
      uploadedAt: new Date('2025-05-01T00:00:00Z'),
    }),
    row({
      name: 'EZ2FAI',
      version: '  2.3.0  ',
      parsedDownload: 'https://example.com/new.zip',
      uploadedAt: new Date('2025-06-01T00:00:00Z'),
    }),
  ]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]?.releases.length, 1);
  assert.equal(grouped[0]?.releases[0]?.parsedDownload, 'https://example.com/new.zip');
});

void test('uploads without a version or download stay on the mod but are not releases', () => {
  const grouped = groupFeedMods([
    row({
      name: 'EZ2FAI',
      version: '2.2.0',
      parsedDownload: 'https://example.com/2.2.0.zip',
      uploadedAt: new Date('2025-03-01T00:00:00Z'),
    }),
    row({
      name: 'EZ2FAI',
      version: '',
      parsedDownload: '',
      uploadedAt: new Date('2025-07-01T00:00:00Z'),
      description: 'latest notes',
    }),
  ]);
  assert.equal(grouped[0]?.version, '');
  assert.equal(grouped[0]?.description, 'latest notes');
  assert.equal(grouped[0]?.releases.length, 1);
  assert.equal(grouped[0]?.releases[0]?.version, '2.2.0');
});
