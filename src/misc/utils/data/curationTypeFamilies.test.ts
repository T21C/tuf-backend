import assert from 'node:assert/strict';
import test from 'node:test';
import {
  curationTypeIdSetsEqual,
  mergeCurationTypesByFamilyTier,
  parseCurationFamilyTier,
} from './curationTypeFamilies.js';

test('parseCurationFamilyTier reads C/V/O/H plus optional digits', () => {
  assert.deepEqual(parseCurationFamilyTier('C1'), { letter: 'C', tier: 1 });
  assert.deepEqual(parseCurationFamilyTier('c2'), { letter: 'C', tier: 2 });
  assert.deepEqual(parseCurationFamilyTier('V0'), { letter: 'V', tier: 0 });
  assert.deepEqual(parseCurationFamilyTier('H'), { letter: 'H', tier: 0 });
  assert.deepEqual(parseCurationFamilyTier('O3'), { letter: 'O', tier: 3 });
  assert.equal(parseCurationFamilyTier('Legendary'), null);
  assert.equal(parseCurationFamilyTier('C1x'), null);
  assert.equal(parseCurationFamilyTier(''), null);
});

test('merge steps up C1 to C2 and drops the lower tier', () => {
  const existing = [{ id: 1, name: 'C1' }, { id: 10, name: 'V2' }];
  const incoming = [{ id: 2, name: 'C2' }];
  assert.deepEqual(mergeCurationTypesByFamilyTier(existing, incoming), [2, 10]);
});

test('merge does not step down an existing higher tier', () => {
  const existing = [{ id: 2, name: 'C2' }];
  const incoming = [{ id: 1, name: 'C1' }];
  assert.deepEqual(mergeCurationTypesByFamilyTier(existing, incoming), [2]);
});

test('merge collapses C1 and C2 in the same incoming list', () => {
  const incoming = [
    { id: 1, name: 'C1' },
    { id: 2, name: 'C2' },
    { id: 3, name: 'V1' },
  ];
  assert.deepEqual(mergeCurationTypesByFamilyTier([], incoming), [2, 3]);
});

test('merge keeps independent families and unions misc names', () => {
  const existing = [
    { id: 1, name: 'C1' },
    { id: 20, name: 'Legendary' },
  ];
  const incoming = [
    { id: 2, name: 'C2' },
    { id: 30, name: 'H1' },
    { id: 40, name: 'Featured' },
  ];
  assert.deepEqual(mergeCurationTypesByFamilyTier(existing, incoming), [2, 20, 30, 40]);
});

test('identical merged set is equal for no-op detection', () => {
  const existing = [{ id: 2, name: 'C2' }, { id: 10, name: 'V3' }];
  const incoming = [{ id: 1, name: 'C1' }];
  const merged = mergeCurationTypesByFamilyTier(existing, incoming);
  assert.deepEqual(merged, [2, 10]);
  assert.equal(curationTypeIdSetsEqual(merged, existing.map((t) => t.id)), true);
  assert.equal(curationTypeIdSetsEqual(merged, [2, 10, 1]), false);
});
