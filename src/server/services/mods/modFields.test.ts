import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DESCRIPTION_MAX,
  NAME_MAX,
  isGithubHostedUrl,
  parseGithubImageUrl,
  parseHttpUrl,
  parseModCreate,
  parseModPatch,
} from './modFields.js';

void test('parseHttpUrl accepts http(s) and rejects dangerous schemes', () => {
  assert.equal(parseHttpUrl('https://github.com/a/b/releases').ok, true);
  assert.equal(parseHttpUrl('javascript:alert(1)', 'downloadUrl').ok, false);
  assert.equal(parseHttpUrl('https://user:pass@evil.example/x', 'downloadUrl').ok, false);
});

void test('isGithubHostedUrl accepts github and githubusercontent hosts', () => {
  assert.equal(isGithubHostedUrl('https://github.com/org/repo/raw/main/icon.png'), true);
  assert.equal(
    isGithubHostedUrl('https://raw.githubusercontent.com/org/repo/main/icon.png'),
    true,
  );
  assert.equal(isGithubHostedUrl('https://cdn.discordapp.com/attachments/1/2/icon.png'), false);
});

void test('parseGithubImageUrl rejects discord hosts and blank becomes null', () => {
  const blank = parseGithubImageUrl('  ');
  assert.equal(blank.ok, true);
  if (blank.ok) assert.equal(blank.value, null);
  const discord = parseGithubImageUrl('https://cdn.discordapp.com/attachments/1/2/a.png');
  assert.equal(discord.ok, false);
  const github = parseGithubImageUrl('https://raw.githubusercontent.com/a/b/main/i.png');
  assert.equal(github.ok, true);
});

void test('parseModCreate requires core fields and defaults hidden/sourceUploadedAt', () => {
  const missing = parseModCreate({});
  assert.equal(missing.ok, false);

  const created = parseModCreate({
    name: '  AdofaiTweaks  ',
    creatorUsername: '  crackthrough  ',
    creatorDiscordId: '543672901585469441',
    downloadUrl: 'https://github.com/PizzaLovers007/AdofaiTweaks/releases',
    version: '  2.9.2  ',
    description: '  tweaks  ',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.value.name, 'AdofaiTweaks');
  assert.equal(created.value.creatorUsername, 'crackthrough');
  assert.equal(created.value.creatorDiscordId, '543672901585469441');
  assert.equal(created.value.version, '2.9.2');
  assert.equal(created.value.description, 'tweaks');
  assert.equal(created.value.hidden, false);
  assert.ok(created.value.sourceUploadedAt instanceof Date);
  assert.equal(created.value.imageUrl, null);
  assert.equal(created.value.projectUrl, null);
  assert.equal(created.value.deprecatedAfter, null);
});

void test('parseModCreate rejects oversized name and description', () => {
  const name = parseModCreate({
    name: 'x'.repeat(NAME_MAX + 1),
    creatorUsername: 'user',
    creatorDiscordId: '12345',
    downloadUrl: 'https://github.com/a/b',
  });
  assert.equal(name.ok, false);

  const description = parseModCreate({
    name: 'Mod',
    creatorUsername: 'user',
    creatorDiscordId: '12345',
    downloadUrl: 'https://github.com/a/b',
    description: 'y'.repeat(DESCRIPTION_MAX + 1),
  });
  assert.equal(description.ok, false);
});

void test('parseModCreate rejects invalid snowflake', () => {
  const result = parseModCreate({
    name: 'Mod',
    creatorUsername: 'user',
    creatorDiscordId: 'not-a-snowflake',
    downloadUrl: 'https://github.com/a/b',
  });
  assert.equal(result.ok, false);
});

void test('parseModCreate rejects imageUrl and javascript projectUrl', () => {
  const imageUrl = parseModCreate({
    name: 'Mod',
    creatorUsername: 'user',
    creatorDiscordId: '12345',
    downloadUrl: 'https://github.com/a/b',
    imageUrl: 'https://raw.githubusercontent.com/a/b/main/icon.png',
  });
  assert.equal(imageUrl.ok, false);
  if (!imageUrl.ok) assert.equal(imageUrl.error, 'Cannot update this field');

  const javascript = parseModCreate({
    name: 'Mod',
    creatorUsername: 'user',
    creatorDiscordId: '12345',
    downloadUrl: 'https://github.com/a/b',
    projectUrl: 'javascript:alert(1)',
  });
  assert.equal(javascript.ok, false);
});

void test('parseModCreate accepts optional projectUrl from any host', () => {
  const created = parseModCreate({
    name: 'Mod',
    creatorUsername: 'user',
    creatorDiscordId: '12345',
    downloadUrl: 'https://github.com/a/b/releases',
    projectUrl: 'https://gitlab.com/org/repo',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.value.projectUrl, 'https://gitlab.com/org/repo');
});

void test('parseModCreate and parseModPatch accept optional deprecatedAfter', () => {
  const created = parseModCreate({
    name: 'Mod',
    creatorUsername: 'user',
    creatorDiscordId: '12345',
    downloadUrl: 'https://github.com/a/b/releases',
    deprecatedAfter: '  v2.9.8  ',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.value.deprecatedAfter, 'v2.9.8');

  const patched = parseModPatch({deprecatedAfter: ''});
  assert.equal(patched.ok, true);
  if (!patched.ok) return;
  assert.equal(patched.value.deprecatedAfter, null);

  const tooLong = parseModPatch({deprecatedAfter: 'x'.repeat(65)});
  assert.equal(tooLong.ok, false);
});

void test('parseModPatch updates hidden and projectUrl but rejects imageUrl', () => {
  const empty = parseModPatch({});
  assert.equal(empty.ok, false);

  const imageUrl = parseModPatch({
    hidden: true,
    imageUrl: 'https://raw.githubusercontent.com/a/b/main/icon.png',
  });
  assert.equal(imageUrl.ok, false);
  if (!imageUrl.ok) assert.equal(imageUrl.error, 'Cannot update this field');

  const patched = parseModPatch({
    hidden: true,
    projectUrl: 'https://gitlab.com/org/repo',
  });
  assert.equal(patched.ok, true);
  if (!patched.ok) return;
  assert.equal(patched.value.hidden, true);
  assert.equal(patched.value.projectUrl, 'https://gitlab.com/org/repo');
  assert.equal('imageUrl' in patched.value, false);
});
