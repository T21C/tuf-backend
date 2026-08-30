import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allocateModSlug,
  githubRepoSlugFromUrl,
  preferredModSlug,
  slugifyName,
  uniqueWithNumericSuffix,
} from './modSlug.js';

void test('githubRepoSlugFromUrl reads repo from github and raw hosts', () => {
  assert.equal(
    githubRepoSlugFromUrl('https://github.com/PizzaLovers007/AdofaiTweaks/releases/download/v1/x.zip'),
    'adofaitweaks',
  );
  assert.equal(
    githubRepoSlugFromUrl('https://raw.githubusercontent.com/Owner/My.Repo/main/file.txt'),
    'my-repo',
  );
  assert.equal(githubRepoSlugFromUrl('https://example.com/Owner/Repo'), null);
  assert.equal(JSON.stringify(githubRepoSlugFromUrl('https://github.com/a/b')).includes('process.env'), false);
});

void test('slugifyName drops non-english and uniqueWithNumericSuffix appends -2', () => {
  assert.equal(slugifyName('Adofai Tweaks 2'), 'adofai-tweaks-2');
  assert.equal(slugifyName('한글모드'), '');
  assert.equal(uniqueWithNumericSuffix('tweaks', ['tweaks']), 'tweaks-2');
  assert.equal(uniqueWithNumericSuffix('1.0.0', new Set(['1.0.0', '1.0.0-2'])), '1.0.0-3');
});

void test('allocateModSlug prefers github, then name, then index, and avoids reserved', () => {
  assert.equal(
    preferredModSlug({
      projectUrl: 'https://github.com/org/CoolMod',
      downloadUrl: 'https://example.com/a.zip',
      name: 'Other',
      fallbackIndex: 9,
    }),
    'coolmod',
  );
  assert.equal(
    preferredModSlug({
      name: '한글',
      fallbackIndex: 4,
    }),
    '4',
  );
  const slug = allocateModSlug(
    {name: 'Tags', fallbackIndex: 1},
    [],
  );
  assert.equal(slug, 'tags-2');
  assert.equal(allocateModSlug({name: 'Cool Mod', fallbackIndex: 1}, ['cool-mod']), 'cool-mod-2');
});
