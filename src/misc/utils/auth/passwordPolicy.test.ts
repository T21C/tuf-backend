import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMMON_PASSWORDS,
  PASSWORD_REQUIREMENT_IDS,
  PASSWORD_REQUIREMENT_REGEX,
  evaluatePassword,
  missingPasswordRequirements,
  passwordRejection,
} from './passwordPolicy.js';

test('empty password reports every requirement group', () => {
  const missing = missingPasswordRequirements('');
  assert.deepEqual(missing, [...PASSWORD_REQUIREMENT_IDS]);
  const evaluation = evaluatePassword('');
  assert.equal(evaluation.acceptable, false);
  assert.equal(evaluation.rating, 'weak');
  assert.equal(evaluation.metCount, 0);
  assert.equal(passwordRejection('')?.code, 'PASSWORD_REQUIREMENTS');
});

test('partial passwords report only the failed groups', () => {
  assert.deepEqual(missingPasswordRequirements('abcdefgh'), [
    'missingUpper',
    'missingDigit',
    'missingSymbol',
  ]);
  assert.deepEqual(missingPasswordRequirements('Abcdefgh'), [
    'missingDigit',
    'missingSymbol',
  ]);
  assert.deepEqual(missingPasswordRequirements('Abcdefg1'), ['missingSymbol']);
  assert.equal(evaluatePassword('Abcdefgh').rating, 'fair');
  assert.equal(evaluatePassword('abc').rating, 'weak');
});

test('Abcdef1! meets every composition rule and is accepted', () => {
  const evaluation = evaluatePassword('Abcdef1!');
  assert.deepEqual(evaluation.missing, []);
  assert.equal(evaluation.compositionValid, true);
  assert.equal(evaluation.common, false);
  assert.equal(evaluation.acceptable, true);
  assert.equal(evaluation.rating, 'strong');
  assert.equal(passwordRejection('Abcdef1!'), null);
});

test('every listed common password passes the regex and is rejected as common', () => {
  assert.equal(COMMON_PASSWORDS.length, 37);
  for (const password of COMMON_PASSWORDS) {
    const match = PASSWORD_REQUIREMENT_REGEX.exec(password);
    assert.ok(match?.groups, `regex should match ${password}`);
    for (const id of PASSWORD_REQUIREMENT_IDS) {
      assert.equal(
        match.groups[id],
        undefined,
        `${password} should already satisfy ${id}`,
      );
    }
    const evaluation = evaluatePassword(password);
    assert.equal(evaluation.compositionValid, true);
    assert.equal(evaluation.common, true);
    assert.equal(evaluation.acceptable, false);
    assert.equal(evaluation.rating, 'common');
    assert.equal(passwordRejection(password)?.code, 'PASSWORD_COMMON');
  }
});
