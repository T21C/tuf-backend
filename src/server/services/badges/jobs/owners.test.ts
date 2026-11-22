import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampOwnerRange,
  compareOwners,
  inOwnerRange,
  ownerRangeFrom,
  parseOwnerBound,
  parseOwnerKind,
} from './owners.js';

test('out of range owner ids clamp to the table min and max', () => {
  assert.deepEqual(
    clampOwnerRange({ ownerFrom: 1, ownerTo: 9999 }, { min: 4, max: 800 }),
    { ownerFrom: 4, ownerTo: 800 },
  );
  assert.deepEqual(
    clampOwnerRange({ ownerFrom: null, ownerTo: 9999 }, { min: 1, max: 12 }),
    { ownerFrom: null, ownerTo: 12 },
  );
});

test('ownerKind is player or creator', () => {
  assert.equal(parseOwnerKind('player'), 'player');
  assert.equal(parseOwnerKind('creator'), 'creator');
  assert.equal(parseOwnerKind('owners'), null);
  assert.equal(parseOwnerKind(''), null);
});

test('startFrom is ownerFrom', () => {
  assert.deepEqual(ownerRangeFrom({ startFrom: 4 }), { ownerFrom: 4, ownerTo: null });
  assert.deepEqual(ownerRangeFrom({ ownerFrom: 12, startFrom: 4, ownerTo: 40 }), { ownerFrom: 12, ownerTo: 40 });
  assert.equal(parseOwnerBound(0), null);
  assert.equal(parseOwnerBound(''), null);
});

test('owner range is inclusive on player and creator ids', () => {
  assert.equal(inOwnerRange(4, 4, 10), true);
  assert.equal(inOwnerRange(3, 4, 10), false);
  assert.equal(inOwnerRange(11, 4, 10), false);
  assert.equal(inOwnerRange(1, 4, null), false);
  assert.equal(inOwnerRange(99, 4, null), true);
});

test('players sort before creators, then by id', () => {
  const owners = [
    { audience: 'creator' as const, id: 1 },
    { audience: 'player' as const, id: 4 },
    { audience: 'player' as const, id: 1 },
    { audience: 'creator' as const, id: 8 },
  ];
  assert.deepEqual(owners.sort(compareOwners).map((row) => `${row.audience}:${row.id}`), [
    'player:1',
    'player:4',
    'creator:1',
    'creator:8',
  ]);
});
