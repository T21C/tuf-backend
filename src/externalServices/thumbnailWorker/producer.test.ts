import assert from 'node:assert/strict';
import test from 'node:test';
import {isDuplicateJobIdError, shouldReuseExistingThumbnailJob} from './producerHelpers.js';

test('in-flight and queued jobs are reused instead of re-enqueued', () => {
  for (const state of ['waiting', 'delayed', 'active', 'paused', 'waiting-children', 'prioritized']) {
    assert.equal(shouldReuseExistingThumbnailJob(state), true, state);
  }
});

test('finished jobs are not reused when the output is missing', () => {
  for (const state of ['completed', 'failed', 'unknown']) {
    assert.equal(shouldReuseExistingThumbnailJob(state), false, state);
  }
});

test('BullMQ duplicate jobId errors are treated as a race, not an outage', () => {
  assert.equal(isDuplicateJobIdError(new Error('Job render_level_1_LARGE_png already exists')), true);
  assert.equal(isDuplicateJobIdError(new Error('connection refused')), false);
});
