import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isUniversalRatingProposal,
  isDiscordVoteCard,
  isVoteRerateLabel,
  requestPguBand,
  includeRequestBandsFromFlags,
} from './RatingUtils.js';

test('isVoteRerateLabel matches the rating card VOTE prefix', () => {
  assert.equal(isVoteRerateLabel('vote'), true);
  assert.equal(isVoteRerateLabel('Vote U1'), true);
  assert.equal(isVoteRerateLabel('vote G12'), true);
  assert.equal(isVoteRerateLabel('VOTE'), true);
  assert.equal(isVoteRerateLabel('G20'), false);
  assert.equal(isVoteRerateLabel(''), false);
  assert.equal(isVoteRerateLabel(null), false);
});

test('isDiscordVoteCard treats pipeline vote cards as votes even without a vote prefix', () => {
  assert.equal(isDiscordVoteCard({rerateNum: 'G12', immediateSettle: true}), true);
  assert.equal(isDiscordVoteCard({rerateNum: 'G12', requestStatus: 'discord_vote'}), true);
  assert.equal(isDiscordVoteCard({rerateNum: 'G12'}), false);
  assert.equal(isDiscordVoteCard({
    rerateNum: 'vote G12',
    immediateSettle: true,
    requestStatus: 'discord_vote',
    discordMessageUrl: 'https://discord.com/channels/1/2/3',
    discordThreadClosed: true,
  }), false);
});

test('requestPguBand uses universal proposal as U', () => {
  assert.equal(requestPguBand('U1', null), 'U');
  assert.equal(requestPguBand('', 'Q0'), 'U');
  assert.equal(requestPguBand('G20-U1', null), 'U');
  assert.equal(requestPguBand('21', null), 'U');
});

test('requestPguBand maps Q-bucket labels to their letter', () => {
  assert.equal(requestPguBand('GQ2', null), 'G');
  assert.equal(requestPguBand('GQ2 (G9~G12)', null), 'G');
  assert.equal(requestPguBand('UQ2', null), 'U');
  assert.equal(requestPguBand('Q2', null), 'U');
});

test('requestPguBand uses PGU tokens and legacy numbers without lowDiff', () => {
  assert.equal(requestPguBand('P4', null), 'P');
  assert.equal(requestPguBand('P12', null), 'P');
  assert.equal(requestPguBand(null, 'P1'), 'P');
  assert.equal(requestPguBand('12', null), 'P');
  assert.equal(requestPguBand('G15', null), 'G');
  assert.equal(requestPguBand('G10~12', null), 'G');
});

test('requestPguBand maps legacy feeling numbers to P below 20, G from 20, and U at 21', () => {
  assert.equal(requestPguBand(null, '1'), 'P');
  assert.equal(requestPguBand(null, '19'), 'P');
  assert.equal(requestPguBand(null, '19+'), 'P');
  assert.equal(requestPguBand(null, '20'), 'G');
  assert.equal(requestPguBand(null, '20.0'), 'G');
  assert.equal(requestPguBand(null, '20.7'), 'G');
  assert.equal(requestPguBand(null, '20.9+'), 'G');
  assert.equal(requestPguBand(null, '21'), 'U');
  assert.equal(requestPguBand(null, '21.4'), 'U');
  assert.equal(requestPguBand('19-20', null), 'G');
  assert.equal(requestPguBand('20.7-21', null), 'U');
});

test('requestPguBand ranges take the highest resolved endpoint', () => {
  assert.equal(requestPguBand('P20-G1', null), 'G');
  assert.equal(requestPguBand('G20-U1', null), 'U');
  assert.equal(requestPguBand('20-21', null), 'U');
});

test('requestPguBand residual is G', () => {
  assert.equal(requestPguBand('Grandmaster', null), 'G');
  assert.equal(requestPguBand('', ''), 'G');
  assert.equal(requestPguBand('cleared', null), 'G');
});

test('isUniversalRatingProposal prefers rerateNum', () => {
  assert.equal(isUniversalRatingProposal('P1', 'U1'), false);
  assert.equal(isUniversalRatingProposal('', 'U1'), true);
});

test('includeRequestBandsFromFlags omits the filter when all bands are on', () => {
  assert.equal(includeRequestBandsFromFlags(true, true, true), null);
  assert.deepEqual(includeRequestBandsFromFlags(true, true, false), ['P', 'G']);
  assert.deepEqual(includeRequestBandsFromFlags(false, false, false), []);
});
