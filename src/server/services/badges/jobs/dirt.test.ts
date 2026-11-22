import assert from 'node:assert/strict';
import test from 'node:test';
import { dirtIsEmpty, dirtSummary, mergeDirt, parseDirt, planDirtEnqueue } from './dirt.js';

test('two pass events for the same player merge into one dirt set', () => {
  const first = mergeDirt(parseDirt(null), { players: [7], levels: [44] });
  const second = mergeDirt(first, { players: [7], levels: [45] });
  assert.deepEqual(second.players, [7]);
  assert.deepEqual(second.levels, [44, 45]);
  assert.equal(dirtSummary(second), '1p 2lv');
  assert.equal(dirtIsEmpty(second), false);
});

test('all pending swallows incremental enqueue', () => {
  assert.equal(planDirtEnqueue(true, false), 'drop');
  assert.equal(planDirtEnqueue(true, true), 'drop');
});

test('pending dirty merges, otherwise inserts', () => {
  assert.equal(planDirtEnqueue(false, true), 'merge');
  assert.equal(planDirtEnqueue(false, false), 'insert');
});
