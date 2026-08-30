import assert from 'node:assert/strict';
import test from 'node:test';
import {
  specAnyLevelCreditsCreator,
  specContributingCreditRoles,
  specLevelCreditsByCreatorId,
  specLevelCreditsByCreatorRole,
} from './esQuerySpecs.js';

function asJson(value: unknown): string {
  return JSON.stringify(value);
}

void test('specContributingCreditRoles matches charter and vfxer only', () => {
  const json = asJson(specContributingCreditRoles());
  assert.equal(json.includes('charter'), true);
  assert.equal(json.includes('vfxer'), true);
  assert.equal(json.includes('specialThanks'), false);
});

void test('specLevelCreditsByCreatorRole without role requires contributing roles', () => {
  const json = asJson(
    specLevelCreditsByCreatorRole({
      wildcardValue: '*alice*',
      excludeAliases: true,
    }),
  );
  assert.equal(json.includes('charter'), true);
  assert.equal(json.includes('vfxer'), true);
  assert.equal(json.includes('specialThanks'), false);
  assert.equal(json.includes('alice'), true);
});

void test('specLevelCreditsByCreatorRole with charter does not add vfxer', () => {
  const json = asJson(
    specLevelCreditsByCreatorRole({
      wildcardValue: '*alice*',
      excludeAliases: true,
      role: 'charter',
    }),
  );
  assert.equal(json.includes('"value":"charter"'), true);
  assert.equal(json.includes('"value":"vfxer"'), false);
  assert.equal(json.includes('specialThanks'), false);
});

void test('specAnyLevelCreditsCreator excludes special thanks', () => {
  const json = asJson(
    specAnyLevelCreditsCreator({
      wildcardValue: '*alice*',
      excludeAliases: true,
    }),
  );
  assert.equal(json.includes('charter'), true);
  assert.equal(json.includes('vfxer'), true);
  assert.equal(json.includes('specialThanks'), false);
});

void test('specLevelCreditsByCreatorId requires contributing roles on the same nested credit', () => {
  const query = specLevelCreditsByCreatorId(42);
  const json = asJson(query);
  assert.equal(json.includes('"levelCredits.creatorId"'), true);
  assert.equal(json.includes('42'), true);
  assert.equal(json.includes('charter'), true);
  assert.equal(json.includes('vfxer'), true);
  assert.equal(json.includes('specialThanks'), false);
  assert.equal('nested' in query, true);
});
