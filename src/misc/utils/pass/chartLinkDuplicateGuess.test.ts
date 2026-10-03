import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  guessChartLinkDuplicatePasses,
  type ChartLinkPassCandidate,
} from './chartLinkDuplicateGuess.js';

function pass(
  partial: Partial<ChartLinkPassCandidate> & Pick<ChartLinkPassCandidate, 'id' | 'levelId' | 'scoreV2'>,
): ChartLinkPassCandidate {
  return {
    isDuplicate: false,
    isDuplicateOverridden: false,
    ...partial,
  };
}

describe('guessChartLinkDuplicatePasses', () => {
  it('marks the lower score on the other level regardless of which pass is new', () => {
    const first = guessChartLinkDuplicatePasses([
      pass({id: null, levelId: 100, scoreV2: 1100}),
      pass({id: 1, levelId: 200, scoreV2: 7000}),
    ]);
    assert.deepEqual(first, {markNewPass: true, existingPassIds: []});

    const second = guessChartLinkDuplicatePasses([
      pass({id: null, levelId: 200, scoreV2: 7000}),
      pass({id: 2, levelId: 100, scoreV2: 1100}),
    ]);
    assert.deepEqual(second, {markNewPass: false, existingPassIds: [2]});
  });

  it('leaves same-level reclears on a keeper unmarked', () => {
    const guess = guessChartLinkDuplicatePasses([
      pass({id: null, levelId: 100, scoreV2: 1100}),
      pass({id: 1, levelId: 200, scoreV2: 7000}),
      pass({id: 2, levelId: 200, scoreV2: 6000}),
    ]);
    assert.deepEqual(guess, {markNewPass: true, existingPassIds: []});
  });

  it('leaves exact ties unmarked', () => {
    const guess = guessChartLinkDuplicatePasses([
      pass({id: null, levelId: 100, scoreV2: 7000}),
      pass({id: 1, levelId: 200, scoreV2: 7000}),
    ]);
    assert.deepEqual(guess, {markNewPass: false, existingPassIds: []});
  });

  it('skips overridden passes and does not unmark existing duplicates', () => {
    const guess = guessChartLinkDuplicatePasses([
      pass({id: null, levelId: 100, scoreV2: 1100}),
      pass({id: 1, levelId: 200, scoreV2: 7000}),
      pass({id: 2, levelId: 300, scoreV2: 900, isDuplicateOverridden: true}),
      pass({id: 3, levelId: 400, scoreV2: 800, isDuplicate: true}),
    ]);
    assert.deepEqual(guess, {markNewPass: true, existingPassIds: []});
  });

  it('marks every strictly lower pass on non-keeper levels', () => {
    const guess = guessChartLinkDuplicatePasses([
      pass({id: null, levelId: 100, scoreV2: 7000}),
      pass({id: 1, levelId: 200, scoreV2: 1100}),
      pass({id: 2, levelId: 200, scoreV2: 900}),
      pass({id: 3, levelId: 300, scoreV2: 5000}),
    ]);
    assert.deepEqual(guess, {markNewPass: false, existingPassIds: [1, 2, 3]});
  });

  it('marks nothing when the player only has one level in the pool', () => {
    const guess = guessChartLinkDuplicatePasses([
      pass({id: null, levelId: 100, scoreV2: 1100}),
    ]);
    assert.deepEqual(guess, {markNewPass: false, existingPassIds: []});
  });
});
