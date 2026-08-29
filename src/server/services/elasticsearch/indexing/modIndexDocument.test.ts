import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildModCreatorSortKey,
  buildModIndexDocument,
  buildModSearchText,
  serializedModFromIndexSource,
} from './modIndexDocument.js';

const assigned = {
  id: 7,
  name: 'AdofaiTweaks',
  creatorUsername: 'crackthrough',
  creatorDiscordId: '543672901585469441',
  version: '2.9.2',
  description: 'tweaks',
  downloadUrl: 'https://github.com/PizzaLovers007/AdofaiTweaks/releases',
  imageUrl: null,
  projectUrl: 'https://gitlab.com/org/repo',
  sourceUploadedAt: new Date('2026-01-01T00:00:00.000Z'),
  hidden: false,
  assignees: [{userId: 'u1', playerId: 9, name: 'Ali', username: 'alice'}],
  postedBy: {userId: 'u1', playerId: 9, name: 'Ali', username: 'alice'},
};

void test('buildModCreatorSortKey prefers assigned name then dump username', () => {
  assert.equal(buildModCreatorSortKey(assigned), 'Ali');
  assert.equal(
    buildModCreatorSortKey({
      creatorUsername: 'crackthrough',
      assignees: [],
      postedBy: null,
    }),
    'crackthrough',
  );
});

void test('buildModSearchText includes dump identity and assignee username', () => {
  const text = buildModSearchText(assigned);
  assert.equal(text.includes('AdofaiTweaks'), true);
  assert.equal(text.includes('crackthrough'), true);
  assert.equal(text.includes('543672901585469441'), true);
  assert.equal(text.includes('alice'), true);
  assert.equal(text.includes('Ali'), true);
  assert.equal(text.includes('https://gitlab.com/org/repo'), true);
});

void test('buildModIndexDocument always stores hidden, searchText, and creatorSortKey', () => {
  const doc = buildModIndexDocument(assigned);
  assert.equal(doc.hidden, false);
  assert.equal(doc.searchText.includes('alice'), true);
  assert.equal(doc.creatorSortKey, 'Ali');
  assert.equal(doc.assignees[0]?.username, 'alice');
});

void test('serializedModFromIndexSource drops searchText, creatorSortKey, and optional hidden', () => {
  const source = {
    ...buildModIndexDocument(assigned),
    searchText: 'should-not-leak',
    creatorSortKey: 'should-not-leak',
    hidden: true,
  };
  const pub = serializedModFromIndexSource(source);
  assert.equal('searchText' in pub, false);
  assert.equal('creatorSortKey' in pub, false);
  assert.equal('hidden' in pub, false);
  assert.equal(pub.name, 'AdofaiTweaks');

  const admin = serializedModFromIndexSource(source, {includeHidden: true});
  assert.equal(admin.hidden, true);
});
