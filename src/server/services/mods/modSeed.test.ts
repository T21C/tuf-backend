import assert from 'node:assert/strict';
import test from 'node:test';

import {mapModSeedRow, mergeModSeedRows} from './modSeed.js';

const base = {
  cachedUsername: 'crackthrough',
  user: '543672901585469441',
  uploadedTimestamp: 1_700_000_000_000,
  parsedDownload: 'https://fixcdn.hyonsu.com/attachments/1/2/mod.zip',
  download: 'https://cdn.discordapp.com/attachments/1/2/mod.zip',
};

void test('mapModSeedRow maps dump fields and drops discord images', () => {
  const mapped = mapModSeedRow({
    ...base,
    name: '  AdofaiTweaks  ',
    version: '2.9.2',
    description: 'tweaks',
    imageURL: 'https://cdn.discordapp.com/attachments/1/2/icon.png',
  });
  assert.ok(mapped);
  assert.equal(mapped?.name, 'AdofaiTweaks');
  assert.equal(mapped?.downloadUrl, 'https://fixcdn.hyonsu.com/attachments/1/2/mod.zip');
  assert.equal(mapped?.imageUrl, null);
  assert.equal(mapped?.version, '2.9.2');
});

void test('mapModSeedRow always drops imageURL including github hosts', () => {
  const mapped = mapModSeedRow({
    ...base,
    name: 'Tool',
    parsedDownload: 'not-a-url',
    download: 'https://github.com/org/repo/releases/download/1.0/mod.zip',
    imageURL: 'https://raw.githubusercontent.com/org/repo/main/icon.png',
  });
  assert.ok(mapped);
  assert.equal(
    mapped?.downloadUrl,
    'https://github.com/org/repo/releases/download/1.0/mod.zip',
  );
  assert.equal(mapped?.imageUrl, null);
});

void test('mapModSeedRow skips rows without a usable name or url', () => {
  assert.equal(mapModSeedRow({...base, name: '  '}), null);
  assert.equal(
    mapModSeedRow({
      ...base,
      name: 'Broken',
      parsedDownload: 'github.com/no-scheme',
      download: 'also-bad',
    }),
    null,
  );
});

void test('mergeModSeedRows keeps newest timestamp per case-insensitive name', () => {
  const merged = mergeModSeedRows([
    {
      ...base,
      name: 'AdofaiTweaks',
      uploadedTimestamp: 1_600_000_000_000,
      parsedDownload: 'https://fixcdn.hyonsu.com/old.zip',
    },
    {
      ...base,
      name: 'adofaitweaks',
      uploadedTimestamp: 1_800_000_000_000,
      parsedDownload: 'https://github.com/PizzaLovers007/AdofaiTweaks/releases',
    },
    {
      ...base,
      name: 'Hotfix sentence title',
      uploadedTimestamp: 1_700_000_000_000,
    },
  ]);
  assert.equal(merged.length, 2);
  const tweaks = merged.find((row) => row.name.toLowerCase() === 'adofaitweaks');
  assert.equal(
    tweaks?.downloadUrl,
    'https://github.com/PizzaLovers007/AdofaiTweaks/releases',
  );
  assert.ok(merged.some((row) => row.name === 'Hotfix sentence title'));
});

void test('mergeModSeedRows prefers github download on timestamp ties', () => {
  const merged = mergeModSeedRows([
    {
      ...base,
      name: 'Same',
      uploadedTimestamp: 1_700_000_000_000,
      parsedDownload: 'https://fixcdn.hyonsu.com/a.zip',
    },
    {
      ...base,
      name: 'Same',
      uploadedTimestamp: 1_700_000_000_000,
      parsedDownload: 'https://github.com/org/repo/releases',
    },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].downloadUrl, 'https://github.com/org/repo/releases');
});
