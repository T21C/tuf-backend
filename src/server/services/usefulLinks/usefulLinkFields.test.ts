import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TAG_GROUP_NAME_MAX,
  mergeOrderedIds,
  parseHexColor,
  parseLocaleFields,
  parseHttpUrl,
  parseOrderedIds,
  parseSortOrders,
  parseTagGroupName,
  parseTagIds,
  parseUsefulLinkCreate,
  parseUsefulLinkPatch,
  TITLE_MAX,
} from './usefulLinkFields.js';
import {serializeUsefulLink, compareSerializedLinkOrder} from './serializeUsefulLink.js';
import {resolveLinkLocale, linkHasLocale} from './serializeUsefulLink.js';
import {
  canEditCluster,
  canViewCluster,
  isPublishTransition,
  ownerMaySetViewMode,
  UsefulLinkClusterViewModes,
} from './usefulLinkClusterAccess.js';
import {checkPublishReady, itemsByLocale} from './usefulLinkClusterService.js';
import {permissionFlags} from '@/config/constants.js';
import {isConfiguredSiteLanguage, siteLanguageCodesMatchingQuery} from '@/config/siteLanguages.js';

const hasFlag = (user: {permissionFlags?: bigint} | null, flag: bigint) =>
  Boolean(user && (BigInt(user.permissionFlags ?? 0) & flag) === flag);

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

void test('parseUsefulLinkCreate requires title and url and accepts tagIds', () => {
  const missing = parseUsefulLinkCreate({});
  assert.equal(missing.ok, false);

  const created = parseUsefulLinkCreate({
    title: '  Rating guide  ',
    url: 'https://www.notion.so/rating',
    description: '  How we rate  ',
    tagIds: [3, '3', 1],
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.deepEqual(created.value, {
    title: 'Rating guide',
    url: 'https://www.notion.so/rating',
    description: 'How we rate',
    isPublished: true,
    tagIds: [3, 1],
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
    isPublished: false,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.description, null);
  assert.equal(result.value.isPublished, false);
  assert.deepEqual(result.value.tagIds, []);
});

void test('parseUsefulLinkPatch applies only provided fields', () => {
  const empty = parseUsefulLinkPatch({});
  assert.equal(empty.ok, false);

  const patch = parseUsefulLinkPatch({
    tagIds: [2],
    isPublished: false,
  });
  assert.equal(patch.ok, true);
  if (!patch.ok) return;
  assert.deepEqual(patch.value.tagIds, [2]);
  assert.equal(patch.value.isPublished, false);
  assert.equal(patch.value.title, undefined);
});

void test('parseTagIds rejects invalid ids', () => {
  assert.equal(parseTagIds('nope').ok, false);
  assert.deepEqual(parseTagIds([1, 1, 2]).value, [1, 2]);
});

void test('parseHexColor requires six-digit hex', () => {
  assert.equal(parseHexColor('#ff5733').ok, true);
  assert.equal(parseHexColor('#fff').ok, false);
  assert.equal(parseHexColor('red').ok, false);
});

void test('parseTagGroupName requires a trimmed non-empty name', () => {
  assert.equal(parseTagGroupName('').ok, false);
  assert.equal(parseTagGroupName('  Guides  ').ok, true);
  const long = parseTagGroupName('x'.repeat(TAG_GROUP_NAME_MAX + 1));
  assert.equal(long.ok, false);
});

void test('parseLocaleFields requires languageCode title and url', () => {
  const missing = parseLocaleFields({title: 'A', url: 'https://a.example'});
  assert.equal(missing.ok, false);
  const ok = parseLocaleFields({
    languageCode: ' KR ',
    title: '  Guide  ',
    url: 'https://kr.example/docs',
    description: '',
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.value.languageCode, 'kr');
  assert.equal(ok.value.title, 'Guide');
  assert.equal(ok.value.description, null);
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

void test('serializeUsefulLink includes tags and locales', () => {
  const json = serializeUsefulLink({
    id: 1,
    title: 'Guide',
    url: 'https://www.notion.so/x',
    description: null,
    sortWeight: 2,
    isPublished: true,
    isCatalog: true,
    ownerId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    tags: [
      {
        id: 4,
        name: 'KR',
        color: '#FF0000',
        groupId: 1,
        sortOrder: 0,
        tagGroup: {id: 1, name: 'Region', sortOrder: 0},
      },
    ],
    locales: [
      {languageCode: 'en', title: 'Guide', url: 'https://www.notion.so/x', description: null},
      {languageCode: 'kr', title: '가이드', url: 'https://kr.example', description: 'ko'},
    ],
  } as any);
  assert.equal(json.tags[0].group, 'Region');
  assert.equal(json.locales[0].languageCode, 'en');
  assert.equal(json.locales[1].languageCode, 'kr');
});

void test('compareSerializedLinkOrder sorts by sortWeight then id', () => {
  const base = {
    title: 'A',
    url: 'https://a.example',
    description: null,
    isPublished: true,
    isCatalog: true,
    ownerId: null,
    tags: [],
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
    {languageCode: 'en', title: 'EN', url: 'https://en.example', description: null},
    {languageCode: 'kr', title: 'KR', url: 'https://kr.example', description: null},
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
    {languageCode: 'en', title: 'EN', url: 'https://en.example', description: null},
    {languageCode: 'xx', title: 'XX', url: 'https://xx.example', description: null},
  ];
  assert.equal(resolveLinkLocale(locales, 'xx')?.title, 'XX');
});

void test('canEditCluster freezes public clusters for owners and thaws when unpublished', () => {
  const owner = {id: 'owner-1', permissionFlags: 0n};
  const admin = {id: 'admin-1', permissionFlags: permissionFlags.SUPER_ADMIN};
  const publicCluster = {ownerId: 'owner-1', viewMode: UsefulLinkClusterViewModes.PUBLIC};
  const privateCluster = {ownerId: 'owner-1', viewMode: UsefulLinkClusterViewModes.PRIVATE};

  assert.equal(canEditCluster(publicCluster, owner, hasFlag, permissionFlags.SUPER_ADMIN), false);
  assert.equal(canEditCluster(privateCluster, owner, hasFlag, permissionFlags.SUPER_ADMIN), true);
  assert.equal(canEditCluster(publicCluster, admin, hasFlag, permissionFlags.SUPER_ADMIN), true);
  assert.equal(canViewCluster(publicCluster, null, hasFlag, permissionFlags.SUPER_ADMIN), true);
  assert.equal(canViewCluster(privateCluster, null, hasFlag, permissionFlags.SUPER_ADMIN), false);
  assert.equal(
    ownerMaySetViewMode(UsefulLinkClusterViewModes.PRIVATE, UsefulLinkClusterViewModes.LINKONLY),
    true,
  );
  assert.equal(
    ownerMaySetViewMode(UsefulLinkClusterViewModes.PRIVATE, UsefulLinkClusterViewModes.PUBLIC),
    false,
  );
  assert.equal(
    isPublishTransition(UsefulLinkClusterViewModes.PRIVATE, UsefulLinkClusterViewModes.PUBLIC),
    true,
  );
  assert.equal(
    isPublishTransition(UsefulLinkClusterViewModes.PUBLIC, UsefulLinkClusterViewModes.PUBLIC),
    false,
  );
  assert.equal(
    isPublishTransition(UsefulLinkClusterViewModes.PUBLIC, UsefulLinkClusterViewModes.PRIVATE),
    false,
  );
});

void test('publish checklist requires en and contested locale defaults', () => {
  const enOnly = {
    id: 1,
    clusterId: 1,
    linkId: 10,
    sortOrder: 0,
    link: {
      id: 10,
      title: 'A',
      url: 'https://a.example',
      description: null,
      sortWeight: 0,
      isPublished: true,
      isCatalog: true,
      ownerId: null,
      tags: [],
      locales: [{languageCode: 'en', title: 'A', url: 'https://a.example', description: null}],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
  const krA = {
    ...enOnly,
    id: 2,
    linkId: 11,
    link: {
      ...enOnly.link,
      id: 11,
      locales: [
        {languageCode: 'en', title: 'A', url: 'https://a.example', description: null},
        {languageCode: 'kr', title: '가', url: 'https://kr-a.example', description: null},
      ],
    },
  };
  const krB = {
    ...enOnly,
    id: 3,
    linkId: 12,
    link: {
      ...enOnly.link,
      id: 12,
      locales: [
        {languageCode: 'en', title: 'B', url: 'https://b.example', description: null},
        {languageCode: 'kr', title: '나', url: 'https://kr-b.example', description: null},
      ],
    },
  };

  const missingDefault = checkPublishReady([enOnly, krA, krB], []);
  assert.equal(missingDefault.ok, false);

  const ready = checkPublishReady(
    [enOnly, krA, krB],
    [
      {languageCode: 'en', itemId: 1},
      {languageCode: 'kr', itemId: 2},
    ],
  );
  assert.equal(ready.ok, true);

  const sliced = itemsByLocale([enOnly, krA, krB]).get('kr') ?? [];
  assert.deepEqual(sliced.map((row) => row.id), [2, 3]);
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
