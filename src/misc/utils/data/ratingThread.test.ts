import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readRatingThreadRequest,
  ratingThreadWantsPing,
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
