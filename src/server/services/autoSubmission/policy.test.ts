import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_SUBMISSION_DENIAL_REASONS,
  getAutoSubmissionEligibility,
  parseTrustedUserIds,
  readAutoSubmissionPolicy,
} from './policy.js';

const testerId = '670cac2c-8175-46a6-87f7-b92741d4499f';

test('auto submission defaults off and an empty allowlist denies everyone', () => {
  assert.deepEqual(readAutoSubmissionPolicy({}), {
    enabled: false,
    trustedUserIds: new Set(),
  });
  assert.deepEqual(getAutoSubmissionEligibility(testerId, {}), {
    can_submit: false,
    denial_reason: AUTO_SUBMISSION_DENIAL_REASONS.DISABLED,
  });
});

test('enabled policy allows only configured UUIDs case-insensitively', () => {
  const env = {
    AUTO_SUBMISSION_ENABLED: 'true',
    AUTO_SUBMISSION_TRUSTED_USER_IDS: testerId.toUpperCase(),
  };
  assert.deepEqual(getAutoSubmissionEligibility(testerId, env), {
    can_submit: true,
    denial_reason: null,
  });
  assert.deepEqual(getAutoSubmissionEligibility('3f13a228-8f98-421d-882e-9a49be85d86e', env), {
    can_submit: false,
    denial_reason: AUTO_SUBMISSION_DENIAL_REASONS.TESTER_REQUIRED,
  });
});

test('malformed enable values and UUID allowlists fail closed', () => {
  for (const enabled of ['enabled', '2', ' true-ish ']) {
    assert.equal(readAutoSubmissionPolicy({
      AUTO_SUBMISSION_ENABLED: enabled,
      AUTO_SUBMISSION_TRUSTED_USER_IDS: testerId,
    }).enabled, false);
  }
  assert.deepEqual(parseTrustedUserIds(`${testerId},not-a-uuid`), {
    valid: false,
    ids: new Set(),
  });
  assert.deepEqual(parseTrustedUserIds(`${testerId}, `), {
    valid: false,
    ids: new Set(),
  });
  assert.equal(readAutoSubmissionPolicy({
    AUTO_SUBMISSION_ENABLED: '1',
    AUTO_SUBMISSION_TRUSTED_USER_IDS: 'not-a-uuid',
  }).enabled, false);
});
