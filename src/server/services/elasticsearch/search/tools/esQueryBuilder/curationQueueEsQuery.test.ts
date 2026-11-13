import assert from 'node:assert/strict';
import test from 'node:test';
import {curationQueueMustClauses} from './curationQueueEsQuery.js';
import {termField} from './esQueryPrimitives.js';

test('curationQueueMustClauses always requires toCuration and visible levels', () => {
  assert.deepEqual(curationQueueMustClauses(), [
    termField('toCuration', true),
    termField('isDeleted', false),
    termField('isHidden', false),
  ]);
});

test('curationQueueMustClauses adds a known flow and ignores junk', () => {
  assert.deepEqual(curationQueueMustClauses({flow: 'Recent'}), [
    termField('toCuration', true),
    termField('isDeleted', false),
    termField('isHidden', false),
    termField('curationFlow', 'recent'),
  ]);
  assert.deepEqual(curationQueueMustClauses({flow: 'vote'}), [
    termField('toCuration', true),
    termField('isDeleted', false),
    termField('isHidden', false),
  ]);
});
