import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TAG_GROUP_NAME_MAX,
  mergeOrderedIds,
  parseGroupAssignmentSnapshot,
  parseGroupLocaleFields,
  parseLocaleFields,
  GROUP_NAME_MAX,
  parseHttpUrl,
  parseOrderedIds,
  parseSortOrders,
  parseTagGroupName,
  parseTagIds,
  parseUsefulLinkCreate,
  parseUsefulLinkPatch,
  TITLE_MAX,
  SHORTHAND_MAX,
} from './usefulLinkFields.js';
import {serializeUsefulLink, compareSerializedLinkOrder} from './serializeUsefulLink.js';
import {resolveLinkLocale, linkHasLocale} from './serializeUsefulLink.js';
import {isConfiguredSiteLanguage, siteLanguageCodesMatchingQuery} from '@/config/siteLanguages.js';

void test('parseHttpUrl accepts http(s) and rejects dangerous schemes', () => {
  assert.equal(parseHttpUrl('https://www.notion.so/TUF-guides-abc').ok, true);
  const http = parseHttpUrl('http://example.com/docs');
  assert.equal(http.ok, true);
  assert.equal(parseHttpUrl('javascript:alert(1)').ok, false);
  assert.equal(parseHttpUrl('data:text/html,hi').ok, false);
  assert.equal(parseHttpUrl('ftp://files.example').ok, false);
  assert.equal(parseHttpUrl('not a url').ok, false);
  assert.equal(parseHttpUrl('https://user:pass@evil.example/x').ok, false);
});

void test('parseUsefulLinkCreate requires title and url and accepts groupIds', () => {
  const missing = parseUsefulLinkCreate({});
  assert.equal(missing.ok, false);

  const created = parseUsefulLinkCreate({
    title: '  Rating guide  ',
    url: 'https://www.notion.so/rating',
    description: '  How we rate  ',
    shorthand: '  TUF Notion  ',
    groupIds: [3, '3', 1],
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.deepEqual(created.value, {
    title: 'Rating guide',
    url: 'https://www.notion.so/rating',
    description: 'How we rate',
    shorthand: 'TUF Notion',
    groupIds: [3, 1],
  });
});

void test('parseUsefulLinkCreate rejects oversized title', () => {
  const result = parseUsefulLinkCreate({
    title: 'x'.repeat(TITLE_MAX + 1),
    url: 'https://www.notion.so/x',
  });
  assert.equal(result.ok, false);
});

void test('parseUsefulLinkCreate blank optional fields become null', () => {
  const result = parseUsefulLinkCreate({
    title: 'Docs',
    url: 'https://www.notion.so/docs',
    description: '   ',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.description, null);
  assert.equal(result.value.shorthand, null);
  assert.deepEqual(result.value.groupIds, []);
});

void test('parseUsefulLinkCreate rejects oversized shorthand', () => {
  const result = parseUsefulLinkCreate({
    title: 'Docs',
    url: 'https://www.notion.so/docs',
    shorthand: 'x'.repeat(SHORTHAND_MAX + 1),
  });
  assert.equal(result.ok, false);
});

void test('parseUsefulLinkPatch applies only provided fields', () => {
  const empty = parseUsefulLinkPatch({});
  assert.equal(empty.ok, false);

  const patch = parseUsefulLinkPatch({
    groupIds: [2],
  });
  assert.equal(patch.ok, true);
  if (!patch.ok) return;
  assert.deepEqual(patch.value.groupIds, [2]);
  assert.equal(patch.value.title, undefined);

  const shorthandPatch = parseUsefulLinkPatch({shorthand: '  TUF Notion  '});
  assert.equal(shorthandPatch.ok, true);
  if (!shorthandPatch.ok) return;
  assert.equal(shorthandPatch.value.shorthand, 'TUF Notion');

  const clearShorthand = parseUsefulLinkPatch({shorthand: '   '});
  assert.equal(clearShorthand.ok, true);
  if (!clearShorthand.ok) return;
  assert.equal(clearShorthand.value.shorthand, null);
});

void test('parseTagIds rejects invalid ids', () => {
  assert.equal(parseTagIds('nope').ok, false);
  const ids = parseTagIds([1, 1, 2]);
  assert.equal(ids.ok, true);
  if (!ids.ok) return;
  assert.deepEqual(ids.value, [1, 2]);
});

void test('parseTagGroupName requires a trimmed non-empty name', () => {
  assert.equal(parseTagGroupName('').ok, false);
  assert.equal(parseTagGroupName('  Guides  ').ok, true);
  const long = parseTagGroupName('x'.repeat(TAG_GROUP_NAME_MAX + 1));
  assert.equal(long.ok, false);
});

void test('parseGroupLocaleFields requires languageCode and a trimmed name', () => {
  const missingCode = parseGroupLocaleFields({name: 'Guides'});
  assert.equal(missingCode.ok, false);

  const missingName = parseGroupLocaleFields({languageCode: 'kr'});
  assert.equal(missingName.ok, false);

  const blankName = parseGroupLocaleFields({languageCode: 'kr', name: '   '});
  assert.equal(blankName.ok, false);

  const ok = parseGroupLocaleFields({languageCode: ' KR ', name: '  가이드  '});
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.value.languageCode, 'kr');
  assert.equal(ok.value.name, '가이드');

  const oversized = parseGroupLocaleFields({
    languageCode: 'en',
    name: 'x'.repeat(GROUP_NAME_MAX + 1),
  });
  assert.equal(oversized.ok, false);

  const longCode = parseGroupLocaleFields({
    languageCode: 'toolongcode',
    name: 'Guides',
  });
  assert.equal(longCode.ok, false);
});

void test('parseGroupAssignmentSnapshot keeps ordered unique link ids per group', () => {
  const parsed = parseGroupAssignmentSnapshot([
    {id: 2, linkIds: [5, 5, 1]},
    {id: 1, linkIds: ['3', 0, 4]},
  ]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value, [
    {id: 2, linkIds: [5, 1]},
    {id: 1, linkIds: [3, 4]},
  ]);
  assert.equal(parseGroupAssignmentSnapshot('nope').ok, false);
  assert.equal(parseGroupAssignmentSnapshot([{id: 1}, {id: 1, linkIds: []}]).ok, false);
});

void test('parseLocaleFields requires languageCode title and url', () => {
  const missing = parseLocaleFields({title: 'A', url: 'https://a.example'});
  assert.equal(missing.ok, false);
  const ok = parseLocaleFields({
    languageCode: ' KR ',
    title: '  Guide  ',
    url: 'https://kr.example/docs',
    description: '',
    shorthand: '  TUF  ',
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.value.languageCode, 'kr');
  assert.equal(ok.value.title, 'Guide');
  assert.equal(ok.value.description, null);
  assert.equal(ok.value.shorthand, 'TUF');

  const blankShorthand = parseLocaleFields({
    languageCode: 'en',
    title: 'Guide',
    url: 'https://en.example/docs',
    shorthand: '   ',
  });
  assert.equal(blankShorthand.ok, true);
  if (!blankShorthand.ok) return;
  assert.equal(blankShorthand.value.shorthand, null);

  const oversized = parseLocaleFields({
    languageCode: 'en',
    title: 'Guide',
    url: 'https://en.example/docs',
    shorthand: 'x'.repeat(SHORTHAND_MAX + 1),
  });
  assert.equal(oversized.ok, false);
});

void test('parseSortOrders keeps unique positive ids', () => {
  assert.deepEqual(parseSortOrders([{id: '3', sortOrder: 0}, {id: 1, sortOrder: 2}]), [
    {id: 3, sortOrder: 0},
    {id: 1, sortOrder: 2},
  ]);
  assert.deepEqual(parseSortOrders('nope'), []);
});

void test('parseOrderedIds keeps unique positive integers in order', () => {
  assert.deepEqual(parseOrderedIds(['3', 1, 1, 0, -2, 2.5, 2]), [3, 1, 2]);
  assert.deepEqual(parseOrderedIds('nope'), []);
});

void test('mergeOrderedIds uses requested order then appends missing ids', () => {
  assert.deepEqual(mergeOrderedIds([3, 1, 99], [1, 2, 3]), [3, 1, 2]);
});

void test('serializeUsefulLink includes groupIds and locales', () => {
  const json = serializeUsefulLink({
    id: 1,
    title: 'Guide',
    url: 'https://www.notion.so/x',
    description: null,
    shorthand: 'TUF Notion',
    sortWeight: 2,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    groups: [{id: 4}],
    locales: [
      {
        languageCode: 'en',
        title: 'Guide',
        url: 'https://www.notion.so/x',
        description: null,
        shorthand: 'TUF Notion',
      },
      {
        languageCode: 'kr',
        title: '가이드',
        url: 'https://kr.example',
        description: 'ko',
        shorthand: null,
      },
    ],
  } as any);
  assert.deepEqual(json.groupIds, [4]);
  assert.equal(json.shorthand, 'TUF Notion');
  assert.equal(json.locales[0].languageCode, 'en');
  assert.equal(json.locales[0].shorthand, 'TUF Notion');
  assert.equal(json.locales[1].languageCode, 'kr');
  assert.equal(json.locales[1].shorthand, null);
});

void test('compareSerializedLinkOrder sorts by sortWeight then id', () => {
  const base = {
    title: 'A',
    url: 'https://a.example',
    description: null,
    shorthand: null,
    groupIds: [],
    locales: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const sorted = [
    {...base, id: 1, sortWeight: 2},
    {...base, id: 3, sortWeight: 0},
    {...base, id: 2, sortWeight: 0},
  ].sort(compareSerializedLinkOrder);
  assert.deepEqual(sorted.map((row) => row.id), [2, 3, 1]);
});

void test('resolveLinkLocale uses requested locale then falls back to en', () => {
  const locales = [
    {languageCode: 'en', title: 'EN', url: 'https://en.example', description: null, shorthand: null},
    {languageCode: 'kr', title: 'KR', url: 'https://kr.example', description: null, shorthand: 'KR Label'},
  ];
  assert.equal(resolveLinkLocale(locales, 'kr')?.title, 'KR');
  assert.equal(resolveLinkLocale(locales, 'us')?.title, 'EN');
  assert.equal(resolveLinkLocale(locales, 'jp')?.title, 'EN');
  assert.equal(linkHasLocale(locales, 'kr'), true);
  assert.equal(linkHasLocale(locales, 'jp'), false);
});

void test('add language rejects unknown codes but stale locales still resolve', () => {
  assert.equal(isConfiguredSiteLanguage('xx'), false);
  assert.equal(isConfiguredSiteLanguage('kr'), true);
  const locales = [
    {languageCode: 'en', title: 'EN', url: 'https://en.example', description: null, shorthand: 'TUF Notion'},
    {languageCode: 'xx', title: 'XX', url: 'https://xx.example', description: null, shorthand: null},
  ];
  assert.equal(resolveLinkLocale(locales, 'xx')?.title, 'XX');
});

void test('siteLanguageCodesMatchingQuery matches code, native name, and English name', () => {
  assert.deepEqual(siteLanguageCodesMatchingQuery('en', true), ['en']);
  assert.deepEqual(siteLanguageCodesMatchingQuery('EN', true), ['en']);
  assert.deepEqual(siteLanguageCodesMatchingQuery('English'), ['en']);
  assert.deepEqual(siteLanguageCodesMatchingQuery('한국어'), ['kr']);
  assert.deepEqual(siteLanguageCodesMatchingQuery('Korean'), ['kr']);
  assert.deepEqual(siteLanguageCodesMatchingQuery('kr', true), ['kr']);
  assert.deepEqual(siteLanguageCodesMatchingQuery('French'), ['fr']);
  assert.deepEqual(siteLanguageCodesMatchingQuery('Français'), ['fr']);
  assert.deepEqual(siteLanguageCodesMatchingQuery('xyz'), []);
});
