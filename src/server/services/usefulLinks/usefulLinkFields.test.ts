import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GROUP_NAME_MAX,
  mergeOrderedIds,
  parseGroupName,
  parseHttpUrl,
  parseOrderedIds,
  parseSortOrders,
  parseUsefulLinkCreate,
  parseUsefulLinkPatch,
  TITLE_MAX,
} from './usefulLinkFields.js';
import {serializeUsefulLink, compareSerializedLinkOrder} from './serializeUsefulLink.js';

void test('parseHttpUrl accepts http(s) and rejects dangerous schemes', () => {
  assert.equal(
    parseHttpUrl('https://www.notion.so/TUF-guides-abc').ok,
    true,
  );
  const http = parseHttpUrl('http://example.com/docs');
  assert.equal(http.ok, true);

  assert.equal(parseHttpUrl('javascript:alert(1)').ok, false);
  assert.equal(parseHttpUrl('data:text/html,hi').ok, false);
  assert.equal(parseHttpUrl('ftp://files.example').ok, false);
  assert.equal(parseHttpUrl('not a url').ok, false);
  assert.equal(parseHttpUrl('https://user:pass@evil.example/x').ok, false);
});

void test('parseUsefulLinkCreate requires title and url and trims optional fields', () => {
  const missing = parseUsefulLinkCreate({});
  assert.equal(missing.ok, false);

  const created = parseUsefulLinkCreate({
    title: '  Rating guide  ',
    url: 'https://www.notion.so/rating',
    description: '  How we rate  ',
    group: '  Guides  ',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.deepEqual(created.value, {
    title: 'Rating guide',
    url: 'https://www.notion.so/rating',
    description: 'How we rate',
    isPublished: true,
    group: 'Guides',
    groupId: null,
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
    group: '',
    isPublished: false,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.description, null);
  assert.equal(result.value.group, null);
  assert.equal(result.value.groupId, null);
  assert.equal(result.value.isPublished, false);
});

void test('parseUsefulLinkCreate accepts groupId', () => {
  const result = parseUsefulLinkCreate({
    title: 'Docs',
    url: 'https://www.notion.so/docs',
    groupId: 4,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.groupId, 4);
});

void test('parseUsefulLinkPatch applies only provided fields', () => {
  const empty = parseUsefulLinkPatch({});
  assert.equal(empty.ok, false);

  const patch = parseUsefulLinkPatch({
    group: 'x'.repeat(GROUP_NAME_MAX),
    isPublished: false,
  });
  assert.equal(patch.ok, true);
  if (!patch.ok) return;
  assert.equal(patch.value.group?.length, GROUP_NAME_MAX);
  assert.equal(patch.value.isPublished, false);
  assert.equal(patch.value.title, undefined);
});

void test('parseUsefulLinkPatch clears group with empty string', () => {
  const patch = parseUsefulLinkPatch({group: '  '});
  assert.equal(patch.ok, true);
  if (!patch.ok) return;
  assert.equal(patch.value.group, null);
});

void test('parseGroupName requires a trimmed non-empty name', () => {
  assert.equal(parseGroupName('').ok, false);
  assert.equal(parseGroupName('  Guides  ').ok, true);
  const long = parseGroupName('x'.repeat(GROUP_NAME_MAX + 1));
  assert.equal(long.ok, false);
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

void test('serializeUsefulLink flattens nested group fields', () => {
  const json = serializeUsefulLink({
    id: 1,
    title: 'Guide',
    url: 'https://www.notion.so/x',
    description: null,
    groupId: 9,
    sortWeight: 2,
    isPublished: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    linkGroup: {id: 9, name: 'Guides', sortOrder: 3},
  } as any);
  assert.equal(json.groupId, 9);
  assert.equal(json.group, 'Guides');
  assert.equal(json.groupSortOrder, 3);
});

void test('compareSerializedLinkOrder puts ungrouped last then sortWeight', () => {
  const ungrouped = {
    id: 1,
    title: 'A',
    url: 'https://a.example',
    description: null,
    groupId: null,
    group: null,
    groupSortOrder: null,
    sortWeight: 0,
    isPublished: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const guides = {
    ...ungrouped,
    id: 2,
    groupId: 1,
    group: 'Guides',
    groupSortOrder: 1,
    sortWeight: 5,
  };
  const docs = {
    ...ungrouped,
    id: 3,
    groupId: 2,
    group: 'Docs',
    groupSortOrder: 0,
    sortWeight: 1,
  };
  const sorted = [ungrouped, guides, docs].sort(compareSerializedLinkOrder);
  assert.deepEqual(sorted.map((row) => row.id), [3, 2, 1]);
});
