import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatDifficultyRangeMarks,
  readRatingThreadRequest,
  ratingThreadWantsPing,
  splitRatingRangeTokens,
  voteThreadLabel,
  websiteRatingLabel,
} from './ratingThread.js';

test('rating thread pings are off unless explicitly enabled', () => {
  assert.equal(ratingThreadWantsPing(undefined), false);
  assert.equal(ratingThreadWantsPing({}), false);
  assert.equal(ratingThreadWantsPing({ping: false}), false);
  assert.equal(ratingThreadWantsPing({ping: 'true'}), false);
  assert.equal(ratingThreadWantsPing({ping: true}), true);
  assert.deepEqual(readRatingThreadRequest(undefined), {action: 'create', ping: false});
  assert.deepEqual(readRatingThreadRequest({action: 'close', ping: true}), {action: 'close', ping: true});
  assert.deepEqual(readRatingThreadRequest({action: 'reopen'}), {action: 'reopen', ping: false});
  assert.deepEqual(readRatingThreadRequest({action: 'nope', ping: true}), {action: 'create', ping: true});
});

test('vote labels round-trip between a Discord thread and website rating', () => {
  assert.equal(voteThreadLabel('G12'), 'vote G12');
  assert.equal(voteThreadLabel('vote G12'), 'vote G12');
  assert.equal(voteThreadLabel('  Vote   P3 '), 'vote P3');
  assert.equal(voteThreadLabel('vote'), 'vote');
  assert.equal(voteThreadLabel(''), 'vote');
  assert.equal(websiteRatingLabel('vote G12'), 'G12');
  assert.equal(websiteRatingLabel('Vote'), '');
  assert.equal(websiteRatingLabel('P3'), 'P3');
  assert.equal(voteThreadLabel(websiteRatingLabel('vote U1')), 'vote U1');
});

test('splitRatingRangeTokens copies a letter prefix across a shorthand range', () => {
  assert.deepEqual(splitRatingRangeTokens('G1-2'), ['G1', '-', 'G2']);
  assert.deepEqual(splitRatingRangeTokens('U4'), ['U4']);
  assert.deepEqual(splitRatingRangeTokens('U11-13'), ['U11', '-', 'U13']);
  assert.deepEqual(splitRatingRangeTokens('G20~U1'), ['G20', '~', 'U1']);
  assert.deepEqual(splitRatingRangeTokens('P12-14'), ['P12', '-', 'P14']);
  assert.deepEqual(splitRatingRangeTokens('Censored'), ['Censored']);
  assert.deepEqual(splitRatingRangeTokens(''), []);
});

test('formatDifficultyRangeMarks renders a shorthand range as two emojis', () => {
  const byName = new Map([
    ['g1', {name: 'G1', emoji: ':g1:'}],
    ['g2', {name: 'G2', emoji: ':g2:'}],
    ['u1', {name: 'U1', emoji: ':u1:'}],
    ['u4', {name: 'U4', emoji: ':u4:'}],
    ['u11', {name: 'U11', emoji: ':u11:'}],
    ['u13', {name: 'U13', emoji: ':u13:'}],
    ['g20', {name: 'G20', emoji: ':g20:'}],
  ]);
  assert.equal(formatDifficultyRangeMarks('G1', byName).emojis, ':g1:');
  assert.equal(formatDifficultyRangeMarks('U4', byName).emojis, ':u4:');
  assert.equal(formatDifficultyRangeMarks('G1-2', byName).emojis, ':g1:-:g2:');
  assert.equal(formatDifficultyRangeMarks('G1 - 2', byName).emojis, ':g1:-:g2:');
  assert.equal(formatDifficultyRangeMarks('g1-2', byName).emojis, ':g1:-:g2:');
  assert.equal(formatDifficultyRangeMarks('G1-G2', byName).emojis, ':g1:-:g2:');
  assert.equal(formatDifficultyRangeMarks('U11-13', byName).emojis, ':u11:-:u13:');
  assert.equal(formatDifficultyRangeMarks('G20~U1', byName).emojis, ':g20:~:u1:');
  assert.equal(formatDifficultyRangeMarks('G1-2', byName).names, 'G1-G2');
  assert.equal(
    formatDifficultyRangeMarks('G1-2', new Map([['g1', {name: 'G1', emoji: ':g1:'}]])).emojis,
    ':g1:-G2',
  );
});
