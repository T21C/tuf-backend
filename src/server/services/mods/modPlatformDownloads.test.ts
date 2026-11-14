import assert from 'node:assert/strict';
import test from 'node:test';
import {safeExternalNavigationUrl} from './modPlatformDownloads.js';

void test('mod download redirects accept Discord and GitHub links and reject non-https targets', () => {
  assert.equal(
    safeExternalNavigationUrl('https://discord.com/channels/1/2'),
    'https://discord.com/channels/1/2',
  );
  assert.equal(
    safeExternalNavigationUrl('https://cdn.discordapp.com/attachments/1/2/mod.zip?ex=1&hm=2'),
    'https://cdn.discordapp.com/attachments/1/2/mod.zip?ex=1&hm=2',
  );
  assert.equal(
    safeExternalNavigationUrl('https://github.com/org/repo/releases/download/v1/mod.zip'),
    'https://github.com/org/repo/releases/download/v1/mod.zip',
  );
  for (const raw of [
    'http://discord.com/channels/1/2',
    'javascript:alert(1)',
    'https://user:pass@discord.com/a',
    'https://127.0.0.1/a.zip',
    '//cdn.discordapp.com/a.zip',
  ]) {
    assert.equal(safeExternalNavigationUrl(raw), null, raw);
  }
});
