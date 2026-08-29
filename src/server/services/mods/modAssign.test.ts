import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseAssignAssigneesBody,
  parseModAssigneePatch,
  parsePlayerId,
} from './modFields.js';
import {otherModIdsForSameCreator, postedByAfterUnassign} from './modAssign.js';
import {displayNameForUser, userSummaryFromUser} from './modUsers.js';

void test('parsePlayerId requires a positive integer', () => {
  assert.equal(parsePlayerId(12).ok, true);
  assert.equal(parsePlayerId('12').ok, true);
  assert.equal(parsePlayerId(0).ok, false);
  assert.equal(parsePlayerId('nope').ok, false);
});

void test('parseAssignAssigneesBody reads playerId and applyToSameCreator', () => {
  const parsed = parseAssignAssigneesBody({playerId: 7, applyToSameCreator: true});
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.playerId, 7);
  assert.equal(parsed.value.applyToSameCreator, true);

  const defaults = parseAssignAssigneesBody({playerId: 3});
  assert.equal(defaults.ok, true);
  if (!defaults.ok) return;
  assert.equal(defaults.value.applyToSameCreator, false);
});

void test('parseModAssigneePatch rejects hidden, imageUrl, and creator fields', () => {
  const hidden = parseModAssigneePatch({hidden: true});
  assert.equal(hidden.ok, false);

  const imageUrl = parseModAssigneePatch({
    name: 'Ok',
    imageUrl: 'https://cdn.example/icon.png',
  });
  assert.equal(imageUrl.ok, false);

  const creator = parseModAssigneePatch({name: 'Ok', creatorUsername: 'x'});
  assert.equal(creator.ok, false);

  const ok = parseModAssigneePatch({name: 'Tweaks', description: 'hello'});
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.value.name, 'Tweaks');
  assert.equal(ok.value.description, 'hello');
  assert.equal('hidden' in ok.value, false);
});

void test('parseModAssigneePatch accepts optional projectUrl and rejects javascript', () => {
  const ok = parseModAssigneePatch({projectUrl: 'https://gitlab.com/org/repo'});
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.value.projectUrl, 'https://gitlab.com/org/repo');

  const cleared = parseModAssigneePatch({projectUrl: ''});
  assert.equal(cleared.ok, true);
  if (!cleared.ok) return;
  assert.equal(cleared.value.projectUrl, null);

  const javascript = parseModAssigneePatch({projectUrl: 'javascript:alert(1)'});
  assert.equal(javascript.ok, false);
});

void test('otherModIdsForSameCreator skips current and already assigned', () => {
  const ids = otherModIdsForSameCreator(
    {id: 1, creatorDiscordId: '111'},
    [
      {id: 1, creatorDiscordId: '111'},
      {id: 2, creatorDiscordId: '111'},
      {id: 3, creatorDiscordId: '111'},
      {id: 4, creatorDiscordId: '222'},
    ],
    new Set([3]),
  );
  assert.deepEqual(ids, [2]);
});

void test('postedByAfterUnassign clears only the unassigned user', () => {
  assert.equal(postedByAfterUnassign('aaa', 'aaa'), null);
  assert.equal(postedByAfterUnassign('aaa', 'bbb'), 'aaa');
  assert.equal(postedByAfterUnassign(null, 'aaa'), null);
});

void test('displayNameForUser prefers nickname then username', () => {
  assert.equal(displayNameForUser({id: 'u1', username: 'alice', nickname: 'Ali'}), 'Ali');
  assert.equal(displayNameForUser({id: 'u1', username: 'alice', nickname: '  '}), 'alice');
  assert.equal(displayNameForUser({id: 'u1'}), 'u1');
});

void test('userSummaryFromUser includes username for search', () => {
  const nicknamed = userSummaryFromUser({
    id: 'u1',
    playerId: 9,
    username: '  alice  ',
    nickname: 'Ali',
  });
  assert.equal(nicknamed.name, 'Ali');
  assert.equal(nicknamed.username, 'alice');
  assert.equal(nicknamed.playerId, 9);

  const blank = userSummaryFromUser({id: 'u2', username: '  '});
  assert.equal(blank.name, 'u2');
  assert.equal(blank.username, null);
});
