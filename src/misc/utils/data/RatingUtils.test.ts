import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isUniversalRatingProposal,
  lowDiffFilterForRequestBands,
  requestPguBand,
} from './RatingUtils.js';

test('requestPguBand uses universal proposal as U', () => {
  assert.equal(requestPguBand('U1', null, false), 'U');
  assert.equal(requestPguBand('', 'Q0', false), 'U');
  assert.equal(requestPguBand('G20-U1', null, false), 'U');
  assert.equal(requestPguBand('21', null, true), 'U');
});

test('requestPguBand uses lowDiff / P-prefix as P when not universal', () => {
  assert.equal(requestPguBand('P4', null, true), 'P');
  assert.equal(requestPguBand('P12', null, false), 'P');
  assert.equal(requestPguBand(null, 'P1', false), 'P');
});

test('requestPguBand residual is G', () => {
  assert.equal(requestPguBand('G15', null, false), 'G');
  assert.equal(requestPguBand('Grandmaster', null, false), 'G');
  assert.equal(requestPguBand('', '', false), 'G');
});

test('isUniversalRatingProposal prefers rerateNum', () => {
  assert.equal(isUniversalRatingProposal('P1', 'U1'), false);
  assert.equal(isUniversalRatingProposal('', 'U1'), true);
});

test('lowDiffFilterForRequestBands matches existing P / not-P filters', () => {
  assert.equal(lowDiffFilterForRequestBands(true, false, false), 'only');
  assert.equal(lowDiffFilterForRequestBands(false, true, true), 'hide');
  assert.equal(lowDiffFilterForRequestBands(true, true, false), 'show');
  assert.equal(lowDiffFilterForRequestBands(true, true, true), 'show');
});
