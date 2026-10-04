import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyJudgements } from '../pass/CalcAcc.js';
import {
  classifyPassesIntoClearSets,
  emptyClearSets,
  flagsFromClearSets,
} from './levelClearSets.js';

test('classifyPassesIntoClearSets ignores rows without a level id', () => {
  const sets = classifyPassesIntoClearSets([
    { levelId: null, accuracy: 1, isXPerfectMode: true, judgements: emptyJudgements() },
  ]);
  assert.equal(sets.cleared.size, 0);
  assert.equal(sets.purePerfect.size, 0);
  assert.equal(sets.pureXPerfect.size, 0);
});

test('classifyPassesIntoClearSets marks any pass as cleared', () => {
  const sets = classifyPassesIntoClearSets([
    { levelId: 7, accuracy: 0.92, isXPerfectMode: false },
  ]);
  assert.deepEqual([...sets.cleared], [7]);
  assert.equal(sets.purePerfect.has(7), false);
  assert.equal(sets.pureXPerfect.has(7), false);
});

test('classifyPassesIntoClearSets treats accuracy 1 as pure perfect', () => {
  const sets = classifyPassesIntoClearSets([
    { levelId: 3, accuracy: 1, isXPerfectMode: false },
    { levelId: 4, accuracy: 0.9999999999, isXPerfectMode: false },
  ]);
  assert.equal(sets.purePerfect.has(3), true);
  assert.equal(sets.purePerfect.has(4), true);
});

test('classifyPassesIntoClearSets requires all center perfects in x-perfect mode for XPP', () => {
  const allCenter = emptyJudgements();
  allCenter.perfect = 40;
  const mixed = emptyJudgements();
  mixed.perfect = 38;
  mixed.perfectMinus = 2;

  const sets = classifyPassesIntoClearSets([
    { levelId: 1, accuracy: 1, isXPerfectMode: true, judgements: allCenter },
    { levelId: 2, accuracy: 1, isXPerfectMode: true, judgements: mixed },
    { levelId: 3, accuracy: 1, isXPerfectMode: false, judgements: allCenter },
  ]);
  assert.equal(sets.pureXPerfect.has(1), true);
  assert.equal(sets.purePerfect.has(1), true);
  assert.equal(sets.pureXPerfect.has(2), false);
  assert.equal(sets.purePerfect.has(2), true);
  assert.equal(sets.pureXPerfect.has(3), false);
});

test('flagsFromClearSets maps empty sets to false flags', () => {
  assert.deepEqual(flagsFromClearSets(12, emptyClearSets()), {
    isCleared: false,
    isPurePerfect: false,
    isPureXPerfect: false,
    clearAccuracy: null,
    clearScore: null,
  });
});

test('classifyPassesIntoClearSets keeps the highest-rank pass for tooltip stats', () => {
  const allCenter = emptyJudgements();
  allCenter.perfect = 40;
  const sets = classifyPassesIntoClearSets([
    { levelId: 1, accuracy: 0.98, scoreV2: 900, isXPerfectMode: false },
    { levelId: 1, accuracy: 1, scoreV2: 100, isXPerfectMode: true, judgements: allCenter },
  ]);
  const flags = flagsFromClearSets(1, sets);
  assert.equal(flags.isPureXPerfect, true);
  assert.equal(flags.clearAccuracy, 1);
  assert.equal(flags.clearScore, 100);
});
