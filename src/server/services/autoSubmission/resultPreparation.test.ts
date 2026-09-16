import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {RegistrationInput} from './registrationSchema.js';
import {prepareAutoSubmissionResult} from './resultPreparation.js';

function validation(
  overrides: Partial<RegistrationInput['validation']> = {},
): RegistrationInput['validation'] {
  return {
    validation_contract_version: 2,
    validation_status: 'skipped_trusted_tester',
    result_provenance: 'recorded_game_result',
    validator_version: 'trusted-result-adapter-1',
    rules_version: '1',
    evidence_digest: 'a'.repeat(64),
    official_file_id: 'official-file',
    chart_sha256: 'b'.repeat(64),
    gameplay_hash_version: 1,
    gameplay_hash: 'c'.repeat(64),
    speed: 1,
    key_count: 2,
    is_no_hold_tap: false,
    is_adofai_v2: true,
    adofai_version: 1,
    is_x_perfect_mode: false,
    perfect_minus: 0,
    perfect_plus: 0,
    judgments: [0, 0, 0, 0, 100, 0, 0, 0, 0],
    ...overrides,
  };
}

const scoreContext = {
  baseScore: 100,
  ppBaseScore: 100,
  difficulty: {baseScore: 100, name: 'P1'},
};

test('prepares legacy-era results with the current official midspin count before scoring', () => {
  const result = prepareAutoSubmissionResult(validation(), {
    ...scoreContext,
    midspinCount: 4,
  });
  assert.equal(result.judgements.perfect, 96);
  assert.equal(result.midspinDecrement.applied, true);
  assert.equal(result.midspinDecrement.subtracted, 4);
  assert.equal(result.isAdofaiV2, true);
  assert.notEqual(result.passMetaFlags, "0");
  assert.equal(Number.isFinite(result.accuracy), true);
  assert.equal(Number.isFinite(result.scoreV2), true);
});

test('retains shared midspin_missing behavior when current level analysis has no count', () => {
  const result = prepareAutoSubmissionResult(validation(), {
    ...scoreContext,
    midspinCount: null,
  });
  assert.equal(result.judgements.perfect, 100);
  assert.equal(result.midspinDecrement.applied, false);
  assert.equal(result.midspinDecrement.skippedReason, 'midspin_missing');
  assert.equal(result.passMetaFlags, '0');
});

test('maps competitive XPerfect and split counts without a legacy decrement', () => {
  const result = prepareAutoSubmissionResult(validation({
    is_adofai_v2: false,
    adofai_version: 3,
    is_x_perfect_mode: true,
    perfect_minus: 5,
    perfect_plus: 7,
    judgments: [0, 0, 0, 0, 11, 0, 0, 0, 0],
  }), {
    ...scoreContext,
    midspinCount: 99,
  });
  assert.equal(result.judgements.perfect, 11);
  assert.equal(result.judgements.perfectMinus, 5);
  assert.equal(result.judgements.perfectPlus, 7);
  assert.equal(result.isXPerfectMode, true);
  assert.equal(result.isAdofaiV2, false);
  assert.equal(result.midspinDecrement.skippedReason, 'latest_era');
  assert.equal(result.accuracy, 1);
  assert.equal(Number.isFinite(result.scoreV2), true);
});

test('XPerfect accuracy treats minus/plus as perfect when other buckets exist', () => {
  const result = prepareAutoSubmissionResult(validation({
    is_adofai_v2: false,
    adofai_version: 3,
    is_x_perfect_mode: true,
    perfect_minus: 422,
    perfect_plus: 169,
    judgments: [0, 1, 22, 112, 3893, 20, 6, 0, 0],
  }), scoreContext);
  const total = 4645;
  const weighted = 4484 + 132 * 0.75 + 28 * 0.4 + 0.2;
  assert.equal(result.judgements.perfect, 3893);
  assert.equal(result.accuracy, weighted / total);
});
