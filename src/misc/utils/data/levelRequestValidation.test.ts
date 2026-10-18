import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actionsForRequest,
  canonicalRequestCredits,
  creditRequestSignature,
  requestTeamFromInput,
  collectLevelReferenceIds,
  COMPLETED_LEVEL_REQUEST_STATUSES,
  completedRequestsFilter,
  completionStatusForDifficultyChange,
  isOpenLevelRequestStatus,
  isRealPguRequest,
  resolveRerateRating,
  isTerminalLevelRequestStatus,
  rerateCooldownRemainingMs,
  RERATE_COOLDOWN_MS,
  statusAllowedForType,
} from './levelRequestValidation.js';

test('isRealPguRequest accepts single difficulties and ranges', () => {
  assert.equal(isRealPguRequest('U2'), true);
  assert.equal(isRealPguRequest('G20~U1'), true);
  assert.equal(isRealPguRequest('G20 ~ U1'), true);
  assert.equal(isRealPguRequest('U11-13'), true);
  assert.equal(isRealPguRequest('P1-U20'), true);
});

test('isRealPguRequest rejects non-PGU notation', () => {
  assert.equal(isRealPguRequest(''), false);
  assert.equal(isRealPguRequest('vote'), false);
  assert.equal(isRealPguRequest('Q0'), false);
  assert.equal(isRealPguRequest('21'), false);
  assert.equal(isRealPguRequest('G21'), false);
  assert.equal(isRealPguRequest('U0'), false);
  assert.equal(isRealPguRequest('Censored'), false);
  assert.equal(isRealPguRequest('Impossible'), false);
});

test('rerate ratings accept special difficulties by their stored name', () => {
  const specials = ['Censored', 'Impossible'];
  assert.equal(resolveRerateRating('Censored', specials), 'Censored');
  assert.equal(resolveRerateRating('impossible', specials), 'Impossible');
  assert.equal(resolveRerateRating('  Censored  ', specials), 'Censored');
  assert.equal(resolveRerateRating('U2', specials), 'U2');
  assert.equal(resolveRerateRating('G20 ~ U1', specials), 'G20~U1');
  assert.equal(resolveRerateRating('vote', specials), null);
  assert.equal(resolveRerateRating('Q0', specials), null);
  assert.equal(resolveRerateRating('Censored', []), null);
});

test('an open rerate blocks another until it is terminal', () => {
  assert.equal(isOpenLevelRequestStatus('pending'), true);
  assert.equal(isOpenLevelRequestStatus('accepted'), true);
  assert.equal(isOpenLevelRequestStatus('discord_vote'), true);
  assert.equal(isTerminalLevelRequestStatus('withdrawn'), true);
  assert.equal(isTerminalLevelRequestStatus('rejected'), true);
  assert.equal(isTerminalLevelRequestStatus('completed_changed'), true);
  assert.equal(isOpenLevelRequestStatus('completed_unchanged'), false);
});

test('rerate cooldown is 15 minutes after a terminal request', () => {
  const resolved = new Date('2026-10-13T12:00:00.000Z');
  const during = resolved.getTime() + 5 * 60 * 1000;
  const after = resolved.getTime() + RERATE_COOLDOWN_MS + 1;
  assert.ok(rerateCooldownRemainingMs(resolved, during) > 0);
  assert.equal(rerateCooldownRemainingMs(resolved, after), 0);
  assert.equal(rerateCooldownRemainingMs(null, during), 0);
});

test('completion compares frozen difficulty with the settled difficulty only', () => {
  assert.equal(completionStatusForDifficultyChange(4, 4), 'completed_unchanged');
  assert.equal(completionStatusForDifficultyChange(4, 9), 'completed_changed');
  assert.equal(completionStatusForDifficultyChange(null, 9), 'completed_changed');
});

test('collectLevelReferenceIds keeps the first valid ids and ignores broken text', () => {
  assert.deepEqual(collectLevelReferenceIds('harder than #12 and #12, see #0 #34'), [12, 34]);
});

test('info and curation requests cannot use rerate-only statuses', () => {
  assert.equal(statusAllowedForType('info_change', 'discord_vote'), false);
  assert.equal(statusAllowedForType('curation', 'accepted'), true);
  assert.equal(statusAllowedForType('rerate', 'discord_vote'), true);
  assert.equal(statusAllowedForType('rerate', 'completed'), false);
});

test('pending only offers accept and reject', () => {
  assert.deepEqual(actionsForRequest('rerate', 'pending'), ['accept', 'reject']);
  assert.deepEqual(actionsForRequest('info_change', 'pending'), ['accept', 'reject']);
  assert.deepEqual(actionsForRequest('curation', 'pending'), ['accept', 'reject']);
});

test('accepted rerate offers rating-page, discord vote, complete, and reject', () => {
  assert.deepEqual(
    actionsForRequest('rerate', 'accepted'),
    ['add_to_rating', 'discord_vote', 'complete', 'reject'],
  );
});

test('accepted website requests complete or reject without rating-page actions', () => {
  assert.deepEqual(actionsForRequest('info_change', 'accepted'), ['complete', 'reject']);
  assert.deepEqual(actionsForRequest('tag', 'accepted'), ['complete', 'reject']);
  assert.deepEqual(
    actionsForRequest('curation', 'accepted', {discordMessageUrl: 'https://discord.com/x'}),
    ['complete', 'reject', 'delete_discord'],
  );
});

test('curation discord posts wait for accept', () => {
  assert.deepEqual(actionsForRequest('curation', 'pending', {discordPostError: 'failed'}), ['accept', 'reject']);
  assert.deepEqual(actionsForRequest('curation', 'accepted'), ['retry_discord', 'complete', 'reject']);
  assert.deepEqual(actionsForRequest('curation_rerate', 'accepted'), ['retry_discord', 'complete', 'reject']);
  assert.deepEqual(
    actionsForRequest('curation', 'accepted', {discordPostError: 'failed', discordMessageUrl: 'https://discord.com/x'}),
    ['retry_discord', 'complete', 'reject', 'delete_discord'],
  );
  assert.deepEqual(actionsForRequest('rerate', 'discord_vote'), ['retry_discord']);
  assert.deepEqual(
    actionsForRequest('rerate', 'discord_vote', {discordMessageUrl: 'https://discord.com/x'}),
    ['delete_discord'],
  );
});

test('a rerate on the rating page can still become a discord vote until a thread exists', () => {
  assert.deepEqual(actionsForRequest('rerate', 'added_to_rating_page'), ['discord_vote']);
  assert.deepEqual(
    actionsForRequest('rerate', 'added_to_rating_page', {discordMessageUrl: 'https://discord.com/x'}),
    ['delete_discord'],
  );
});

test('completed list filter defaults to hide and accepts show/only', () => {
  assert.equal(completedRequestsFilter({}), 'hide');
  assert.equal(completedRequestsFilter({completed: 'show'}), 'show');
  assert.equal(completedRequestsFilter({completed: 'only'}), 'only');
  assert.equal(completedRequestsFilter({includeCompleted: '1'}), 'show');
  assert.equal(completedRequestsFilter({completed: 'nope', includeCompleted: true}), 'show');
  assert.equal(COMPLETED_LEVEL_REQUEST_STATUSES.includes('rejected'), true);
});

test('credit targets keep role order and reject duplicates', () => {
  const credits = canonicalRequestCredits([
    {creatorId: 2, role: 'vfxer', isOwner: 1, sortOrder: 3},
    {creatorId: 1, role: 'charter', isOwner: false, sortOrder: 0},
    {creatorId: 1, role: 'vfxer', isOwner: false, sortOrder: 0},
  ]);
  assert.deepEqual(credits, [
    {creatorId: 1, role: 'charter', isOwner: false, sortOrder: 0},
    {creatorId: 1, role: 'vfxer', isOwner: false, sortOrder: 0},
    {creatorId: 2, role: 'vfxer', isOwner: true, sortOrder: 1},
  ]);
  assert.equal(canonicalRequestCredits([{creatorId: 1, role: 'charter', isOwner: true}, {creatorId: 1, role: 'charter', isOwner: false}]), null);
  assert.equal(requestTeamFromInput(null), null);
  assert.equal(requestTeamFromInput({name: '  '}), null);
  assert.deepEqual(requestTeamFromInput({name: ' Nova '}), {id: null, name: 'Nova'});
  assert.equal(requestTeamFromInput({id: 0, name: 'Nova'}), undefined);
  const signature = creditRequestSignature(credits || [], {id: 4, name: 'Nova'});
  assert.equal(signature, creditRequestSignature(canonicalRequestCredits(credits) || [], {id: 4, name: 'Nova'}));
});

test('a closed rerate thread keeps its link and is not offered again', () => {
  assert.deepEqual(
    actionsForRequest('rerate', 'discord_vote', {
      discordMessageUrl: 'https://discord.com/channels/1/2/3',
      discordThreadClosed: true,
    }),
    [],
  );
  assert.deepEqual(
    actionsForRequest('curation', 'accepted', {
      discordMessageUrl: 'https://discord.com/x',
      discordThreadClosed: true,
    }),
    ['complete', 'reject', 'delete_discord'],
  );
});

test('terminal requests have no pipeline actions unless a Discord post remains', () => {
  assert.deepEqual(actionsForRequest('rerate', 'rejected'), []);
  assert.deepEqual(actionsForRequest('rerate', 'completed_changed'), []);
  assert.deepEqual(
    actionsForRequest('rerate', 'completed_changed', {discordMessageUrl: 'https://discord.com/channels/1/2/3'}),
    ['delete_discord'],
  );
  assert.deepEqual(actionsForRequest('info_change', 'completed'), []);
});
