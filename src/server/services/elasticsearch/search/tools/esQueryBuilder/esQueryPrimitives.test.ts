import assert from 'node:assert/strict';
import test from 'node:test';
import {applyIdsFilter, matchNone, termsField, type EsQuery} from './esQueryPrimitives.js';

void test('applyIdsFilter no-ops when ids is omitted', () => {
  const filter: EsQuery[] = [];
  applyIdsFilter(filter, undefined);
  assert.deepEqual(filter, []);
});

void test('applyIdsFilter uses matchNone for an empty id list', () => {
  const filter: EsQuery[] = [];
  applyIdsFilter(filter, []);
  assert.deepEqual(filter, [matchNone()]);
});

void test('applyIdsFilter uses terms on id for a non-empty list', () => {
  const filter: EsQuery[] = [];
  applyIdsFilter(filter, [3, 7, 11]);
  assert.deepEqual(filter, [termsField('id', [3, 7, 11])]);
});

void test('applyIdsFilter exclude is a no-op for an empty id list', () => {
  const filter: EsQuery[] = [];
  applyIdsFilter(filter, [], 'exclude');
  assert.deepEqual(filter, []);
});

void test('applyIdsFilter exclude wraps terms in must_not', () => {
  const filter: EsQuery[] = [];
  applyIdsFilter(filter, [3, 7], 'exclude');
  assert.deepEqual(filter, [{ bool: { must_not: [termsField('id', [3, 7])] } }]);
});
