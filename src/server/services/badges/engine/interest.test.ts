import assert from 'node:assert/strict';
import test from 'node:test';
import { badgeInterests, defMatchesSlice, needsWorld } from './interest.js';
import { normalizeDefinition } from './params.js';
import type { BadgeDraft } from './params.js';

function def(partial: Record<string, unknown>): BadgeDraft {
  const normalized = normalizeDefinition({
    audience: 'player',
    slug: 'test',
    name: 'Test',
    reducer: 'value',
    grant: 'live',
    identity: 'level',
    backfill: 'now',
    curve: { start: 1, step: 1, round: 'none', direction: 'up' },
    params: {},
    ...partial,
  });
  assert.equal(normalized.ok, true, normalized.ok ? '' : normalized.errors.join('; '));
  if (!normalized.ok) throw new Error('normalize failed');
  return normalized.value;
}

test('nth tags chartWorld', () => {
  const tags = badgeInterests(def({ params: { expression: 'curve(nth(3), 1, 100000)' } }));
  assert.equal(tags.has('chartWorld'), true);
  assert.equal(tags.has('ownerPass'), false);
  assert.equal(needsWorld(def({ params: { expression: 'curve(nth(3), 1, 100000)' } })), true);
});

test('difficulty tags catalog', () => {
  const tags = badgeInterests(def({ params: { expression: 'curve(difficulty("U6").cleared, 75, 100000)' } }));
  assert.equal(tags.has('catalog'), true);
  assert.equal(tags.has('ownerPass'), false);
  assert.equal(defMatchesSlice(def({ params: { expression: 'curve(difficulty("U6").cleared, 75, 100000)' } }), 'hotPlayer'), true);
});

test('maxCount tags ownerPass', () => {
  const tags = badgeInterests(def({ params: { expression: 'curve(maxCount(clears, "identity"), 10, 100000)' } }));
  assert.equal(tags.has('ownerPass'), true);
  assert.equal(tags.has('chartWorld'), false);
});

test('pack() tags pack', () => {
  const tags = badgeInterests(def({ params: { expression: 'curve(count(pack()), 1, 1)', packId: 3 } }));
  assert.equal(tags.has('pack'), true);
});

test('creator mine tags creator', () => {
  const tags = badgeInterests(def({
    audience: 'creator',
    params: { expression: 'curve(count(mine), 1, 1)' },
  }));
  assert.equal(tags.has('creator'), true);
  assert.equal(defMatchesSlice(def({
    audience: 'creator',
    params: { expression: 'curve(count(mine), 1, 1)' },
  }), 'hotCreator'), true);
});

test('mixed expressions take the union', () => {
  const tags = badgeInterests(def({
    params: { expression: 'curve(count(clears) + nth(1) + difficulty("G1").cleared, 1, 1)' },
  }));
  assert.equal(tags.has('ownerPass'), true);
  assert.equal(tags.has('chartWorld'), true);
  assert.equal(tags.has('catalog'), true);
});
