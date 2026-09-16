import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registrationSchema, eligibleDifficulty} from './registrationSchema.js';

const input = {
  run_id: '12f1c708-65a2-4e24-a286-17b05ddce2bc',
  owner_id: '842533fc-9a92-4ea8-a319-ebd0e5df6f75',
  grant_id: 'e2cff0bb-9d9e-412a-8416-a453352b3bf2',
  level_id: 123,
  current_file_id: 'official-file',
  validation: {
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
    // Overload, TooEarly, Early, EarlyPerfect, Perfect, LatePerfect, Late, TooLate, Miss.
    judgments: [0, 0, 0, 0, 100, 0, 0, 0, 0],
  },
};

test('eligibility uses names and official PGU type, not database IDs', () => {
  for (const name of ['P1', 'P20', 'G1', 'G20']) assert.equal(eligibleDifficulty('PGU', name), true);
  for (const name of ['P0', 'P21', 'U1', 'G01', 'G1 extra', 'Q1']) assert.equal(eligibleDifficulty('PGU', name), false);
  assert.equal(eligibleDifficulty('SPECIAL', 'P1'), false);
});

test('accepts complete result-v2 evidence while preserving the nine judgment slots', () => {
  assert.equal(registrationSchema.safeParse(input).success, true);
  assert.equal(registrationSchema.safeParse({...input, owner_id: 'not-an-owner'}).success, false);
  for (const gameplayHashVersion of [0, -1, 1.5, 4_294_967_296]) {
    assert.equal(registrationSchema.safeParse({
      ...input,
      validation: {...input.validation, gameplay_hash_version: gameplayHashVersion},
    }).success, false);
  }
  assert.equal(registrationSchema.safeParse({
    ...input,
    validation: {...input.validation, gameplay_hash: 'invalid'},
  }).success, false);
  for (const speed of [NaN, Infinity, 0, -1, 0.5, 101]) {
    assert.equal(registrationSchema.safeParse({
      ...input,
      validation: {...input.validation, speed},
    }).success, false);
  }
  assert.equal(registrationSchema.safeParse({
    ...input,
    validation: {...input.validation, speed: 100},
  }).success, true);
  assert.equal(registrationSchema.safeParse({...input, current_file_id: 'changed-file'}).success, false);
  for (const judgments of [
    [1, 0, 0, 0, 100, 0, 0, 0, 0],
    [0, 0, 0, 0, 100, 0, 0, 0, 1],
    Array(9).fill(0),
  ]) {
    assert.equal(registrationSchema.safeParse({
      ...input,
      validation: {...input.validation, judgments},
    }).success, false);
  }
});

test('requires validation status and provenance to describe the same result source', () => {
  assert.equal(registrationSchema.safeParse({
    ...input,
    validation: {...input.validation, result_provenance: 'gameplay_validator'},
  }).success, false);
  assert.equal(registrationSchema.safeParse({
    ...input,
    validation: {
      ...input.validation,
      validation_status: 'validated',
      result_provenance: 'gameplay_validator',
    },
  }).success, true);
  assert.equal(registrationSchema.safeParse({
    ...input,
    validation: {...input.validation, validation_contract_version: 1},
  }).success, false);
});

test('keeps era and XPerfect flags consistent and accepts competitive split counts', () => {
  assert.equal(registrationSchema.safeParse({
    ...input,
    validation: {...input.validation, adofai_version: 2, is_adofai_v2: false},
  }).success, true);
  assert.equal(registrationSchema.safeParse({
    ...input,
    validation: {...input.validation, is_adofai_v2: false},
  }).success, false);
  assert.equal(registrationSchema.safeParse({
    ...input,
    validation: {
      ...input.validation,
      is_adofai_v2: false,
      adofai_version: 3,
      is_x_perfect_mode: true,
      perfect_minus: 4,
      perfect_plus: 5,
      judgments: [0, 0, 0, 0, 90, 0, 0, 0, 0],
    },
  }).success, true);
  assert.equal(registrationSchema.safeParse({
    ...input,
    validation: {
      ...input.validation,
      perfect_minus: 1,
    },
  }).success, false);
  assert.equal(registrationSchema.safeParse({
    ...input,
    validation: {
      ...input.validation,
      is_adofai_v2: false,
      adofai_version: 2,
      is_x_perfect_mode: true,
    },
  }).success, false);
  assert.equal(registrationSchema.safeParse({
    ...input,
    validation: {
      ...input.validation,
      judgments: Array(9).fill(0),
    },
  }).success, false);
  assert.equal(registrationSchema.safeParse({
    ...input,
    validation: {
      ...input.validation,
      is_adofai_v2: false,
      adofai_version: 3,
      is_x_perfect_mode: true,
      perfect_minus: 1,
      judgments: Array(9).fill(0),
    },
  }).success, true);
});
