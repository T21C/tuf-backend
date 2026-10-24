import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actionsForRequest,
  canonicalRequestCredits,
  creditRequestSignature,
  requestTeamFromInput,
  collectLevelReferenceIds,
  curationRequestIssue,
  curationRequestTypeForLevel,
  normalizePositiveIdList,
  openRequestTypesFor,
  tagRequestIssue,
  COMPLETED_LEVEL_REQUEST_STATUSES,
  completedRequestsFilter,
  completionStatusForDifficultyChange,
  isOpenLevelRequestStatus,
  isRealPguRequest,
  resolveRerateRating,
  reasonWithRequester,
  appendRerateScoreTargetLines,
  formatRerateScoreTargetLines,
  parseRerateScoreTargets,
  parseRerateXaccCurveMeta,
  rerateComparisonLabel,
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

test('rerate comparison labels are artist, song, and parenthesized suffix', () => {
  assert.equal(rerateComparisonLabel('Frums', 'multi_arm', ''), 'Frums - multi_arm');
  assert.equal(rerateComparisonLabel('meganeko', 'Feral', 'All Beats'), 'meganeko - Feral (All Beats)');
  assert.equal(rerateComparisonLabel('snakywine', 'Classy Kitty', '(NSFV)'), 'snakywine - Classy Kitty (NSFV)');
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

test('curation discord retry is available after a failed post', () => {
  assert.deepEqual(
    actionsForRequest('curation', 'pending', {discordPostError: 'failed'}),
    ['retry_discord', 'accept', 'reject'],
  );
  assert.deepEqual(actionsForRequest('curation', 'pending'), ['accept', 'reject']);
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
  assert.equal(COMPLETED_LEVEL_REQUEST_STATUSES.includes('withdrawn'), true);
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

test('a closed rerate thread keeps its link and can be reopened', () => {
  assert.deepEqual(
    actionsForRequest('rerate', 'discord_vote', {
      discordMessageUrl: 'https://discord.com/channels/1/2/3',
      discordThreadClosed: true,
    }),
    ['reopen_discord'],
  );
  assert.deepEqual(
    actionsForRequest('curation', 'accepted', {
      discordMessageUrl: 'https://discord.com/x',
      discordThreadClosed: true,
    }),
    ['complete', 'reject', 'delete_discord'],
  );
});

test('rating page reasons end with the original requester', () => {
  assert.equal(reasonWithRequester('Closer to G15 than G14\n#123', 'ada'), 'Closer to G15 than G14\n#123\nRequested by @ada');
  assert.equal(reasonWithRequester('', 'ada'), 'Requested by @ada');
  assert.equal(reasonWithRequester('Already noted\nRequested by @ada', '@ada'), 'Already noted\nRequested by @ada');
  assert.equal(reasonWithRequester('  Keep this  ', ''), 'Keep this');
});

test('optional rerate score targets omit blanks and reject invalid numbers', () => {
  assert.deepEqual(parseRerateScoreTargets({}), {ok: true, value: {}});
  assert.deepEqual(parseRerateScoreTargets({baseScore: '', ppBaseScore: null}), {ok: true, value: {}});
  assert.deepEqual(parseRerateScoreTargets({baseScore: '12.5', ppBaseScore: 8}), {
    ok: true,
    value: {baseScore: 12.5, ppBaseScore: 8},
  });
  assert.equal(parseRerateScoreTargets({baseScore: -1}).ok, false);
  assert.equal(parseRerateScoreTargets({ppBaseScore: 'nope'}).ok, false);
  const invalid = parseRerateScoreTargets({baseScore: -1});
  if (!invalid.ok) assert.equal(invalid.code, 'base_score');
});

test('rerate score curve keeps pin setup and drops extra fields', () => {
  const parsed = parseRerateXaccCurveMeta({
    poleOffset: 0.0054017154,
    topMultiplier: 5.51289781,
    cutoff: 0.95,
    extra: 'drop',
    pins: {
      accX: 0.985,
      accY: 0.995,
      scoreX: 120,
      scoreY: 200,
      extraPin: true,
      scoresAreXaccMultipliers: true,
    },
    editor: {
      pinInputMode: 'judgements',
      disablePP: true,
      pin1: {sourcePassId: 44, judgements: {perfect: '40', ePerfect: '2', earlyDouble: '0'}},
      pin2: {sourcePassId: 90},
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value?.extra, undefined);
  assert.deepEqual(parsed.value?.pins, {
    accX: 0.985,
    accY: 0.995,
    scoreX: 120,
    scoreY: 200,
    scoresAreXaccMultipliers: true,
  });
  assert.deepEqual(parsed.value?.editor, {
    pinInputMode: 'judgements',
    disablePP: true,
    pin1: {sourcePassId: 44, judgements: {perfect: '40', ePerfect: '2'}},
    pin2: {sourcePassId: 90},
  });
  assert.equal(parseRerateXaccCurveMeta(null).ok, true);
  assert.equal(parseRerateXaccCurveMeta({poleOffset: 2, topMultiplier: 5, pins: {accX: 0.98, accY: 0.99, scoreX: 1, scoreY: 2}}).ok, false);
});

test('rerate score target lines summarize scores and pins without E/G', () => {
  const lines = formatRerateScoreTargetLines({
    baseScore: 12.5,
    ppBaseScore: 8,
    xaccCurveMeta: {
      poleOffset: 0.0054017154,
      topMultiplier: 5.51289781,
      pins: {accX: 0.985, accY: 0.995, scoreX: 120, scoreY: 200},
      editor: {
        pinInputMode: 'judgements',
        pin1: {sourcePassId: 44, judgements: {perfect: '40', ePerfect: '2'}},
        pin2: {sourcePassId: 90},
      },
    },
  });
  assert.deepEqual(lines, [
    'Base score: 12.5',
    'PP base score: 8',
    'Score curve:',
    'Pin 1: 98.5% 120 pass #44 judgements ePerfect 2 perfect 40',
    'Pin 2: 99.5% 200 pass #90',
  ]);
  assert.equal(
    appendRerateScoreTargetLines('Closer to G15\n#123', {baseScore: 12.5}),
    'Closer to G15\n#123\nBase score: 12.5',
  );
  assert.equal(appendRerateScoreTargetLines('Keep this', {}), 'Keep this');
});

test('curation vs curation rerate follows whether the level already has a curation', () => {
  assert.equal(curationRequestTypeForLevel(false), 'curation');
  assert.equal(curationRequestTypeForLevel(true), 'curation_rerate');
  assert.deepEqual(openRequestTypesFor('curation'), ['curation', 'curation_rerate']);
  assert.deepEqual(openRequestTypesFor('curation_rerate'), ['curation', 'curation_rerate']);
  assert.deepEqual(openRequestTypesFor('rerate'), ['rerate']);
});

test('new curation cannot be empty and a rerate cannot match the current types', () => {
  assert.equal(curationRequestIssue('curation', []), 'curation_empty');
  assert.equal(curationRequestIssue('curation', [3]), null);
  assert.equal(curationRequestIssue('curation_rerate', [1, 2], [2, 1]), 'unchanged_curation');
  assert.equal(curationRequestIssue('curation_rerate', [], []), 'unchanged_curation');
  assert.equal(curationRequestIssue('curation_rerate', [], [1]), null);
  assert.equal(curationRequestIssue('curation_rerate', [1], [1, 2]), null);
  assert.equal(tagRequestIssue([4, 5], [5, 4]), 'unchanged_tags');
  assert.equal(tagRequestIssue([], []), 'unchanged_tags');
  assert.equal(tagRequestIssue([], [5]), null);
  assert.deepEqual(normalizePositiveIdList(['3', 3, 0, -1, 8]), [3, 8]);
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
