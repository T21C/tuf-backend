import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceSteps,
  buildSteps,
  encodeQueuePayload,
  failCurrentStep,
  parseQueuePayload,
  shouldSkipEnqueue,
  submissionItemKey,
} from './submissionJobTypes.js';

test('item keys isolate kind without colliding on the same numeric id', () => {
  assert.equal(submissionItemKey('level', 12), 'level:12');
  assert.notEqual(submissionItemKey('level', 12), submissionItemKey('pass', 12));
});

test('enqueue skip treats queued/processing as in-flight and completed as done', () => {
  assert.equal(shouldSkipEnqueue(undefined), null);
  assert.equal(shouldSkipEnqueue('failed'), null);
  assert.equal(shouldSkipEnqueue('queued'), 'inflight');
  assert.equal(shouldSkipEnqueue('processing'), 'inflight');
  assert.equal(shouldSkipEnqueue('completed'), 'done');
  assert.equal(shouldSkipEnqueue('skipped'), 'done');
});

test('queue payloads round-trip and reject malformed entries', () => {
  const encoded = encodeQueuePayload({
    kind: 'level',
    action: 'approve',
    itemId: 9,
    requestId: 'req-1',
    actorId: 'user-1',
  });
  assert.deepEqual(parseQueuePayload(encoded), {
    kind: 'level',
    action: 'approve',
    itemId: 9,
    requestId: 'req-1',
    actorId: 'user-1',
  });
  const withReason = encodeQueuePayload({
    kind: 'level',
    action: 'decline',
    itemId: 9,
    requestId: 'req-1',
    actorId: 'user-1',
    reason: 'duplicate chart',
  });
  assert.deepEqual(parseQueuePayload(withReason), {
    kind: 'level',
    action: 'decline',
    itemId: 9,
    requestId: 'req-1',
    actorId: 'user-1',
    reason: 'duplicate chart',
  });
  assert.equal(parseQueuePayload('not-json'), null);
  assert.equal(parseQueuePayload(JSON.stringify({ kind: 'level' })), null);
});

test('FIFO payloads keep enqueue order', () => {
  const ids = [3, 1, 2];
  const encoded = ids.map(itemId => encodeQueuePayload({
    kind: 'pass',
    action: 'approve',
    itemId,
    requestId: 'batch',
    actorId: null,
  }));
  assert.deepEqual(encoded.map(raw => parseQueuePayload(raw)?.itemId), [3, 1, 2]);
});

test('step advance completes the previous processing step', () => {
  const steps = buildSteps('level', 'approve');
  assert.equal(steps[0]?.id, 'validate');
  const afterValidate = advanceSteps(steps, 'validate');
  assert.equal(afterValidate[0]?.status, 'processing');
  const afterResolve = advanceSteps(afterValidate, 'resolveEntities');
  assert.equal(afterResolve[0]?.status, 'completed');
  assert.equal(afterResolve[1]?.status, 'processing');
  const failed = failCurrentStep(afterResolve);
  assert.equal(failed[1]?.status, 'failed');
});

test('stale active payload is requeued only when the worker lock is gone', async () => {
  const { shouldRecoverActivePayload } = await import('./submissionJobTypes.js');
  assert.equal(shouldRecoverActivePayload({ lockHeld: true, itemStatus: 'processing' }), 'wait');
  assert.equal(shouldRecoverActivePayload({ lockHeld: false, itemStatus: 'processing' }), 'requeue');
  assert.equal(shouldRecoverActivePayload({ lockHeld: false, itemStatus: 'queued' }), 'requeue');
  assert.equal(shouldRecoverActivePayload({ lockHeld: false, itemStatus: undefined }), 'requeue');
  assert.equal(shouldRecoverActivePayload({ lockHeld: false, itemStatus: 'completed' }), 'clear');
  assert.equal(shouldRecoverActivePayload({ lockHeld: false, itemStatus: 'failed' }), 'clear');
});
