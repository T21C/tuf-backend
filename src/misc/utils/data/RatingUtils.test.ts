import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isUniversalRatingProposal,
  requestPguBand,
  includeRequestBandsFromFlags,
} from './RatingUtils.js';

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
