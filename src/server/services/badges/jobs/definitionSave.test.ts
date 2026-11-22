import assert from 'node:assert/strict';
import test from 'node:test';
import { definitionExpression, shouldEnqueueOnSave } from './definitionSave.js';

test('definitionExpression reads the value script', () => {
  assert.equal(definitionExpression({ expression: ' curve(1) ' }), 'curve(1)');
  assert.equal(definitionExpression({ pattern: { expression: 'nth(1)' } }), 'nth(1)');
});

test('forward never enqueues a save job', () => {
  assert.equal(shouldEnqueueOnSave({
    previousExpression: null,
    nextBackfill: 'forward',
    nextParams: { expression: 'curve(1)' },
  }), false);
});

test('now does not enqueue when the expression is unchanged', () => {
  assert.equal(shouldEnqueueOnSave({
    previousExpression: 'curve(1)',
    nextBackfill: 'now',
    nextParams: { expression: 'curve(1)' },
  }), false);
});

test('now enqueues when the expression changed', () => {
  assert.equal(shouldEnqueueOnSave({
    previousExpression: 'curve(1)',
    nextBackfill: 'now',
    nextParams: { expression: 'curve(2)' },
  }), true);
});

test('queue does not enqueue when the expression is unchanged', () => {
  assert.equal(shouldEnqueueOnSave({
    previousExpression: 'curve(1)',
    nextBackfill: 'queue',
    nextParams: { expression: 'curve(1)' },
  }), false);
});
