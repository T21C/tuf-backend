import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateBadge } from './evaluate.js';
import { parseBadgeConfig, validateBadgeConfig } from './importConfig.js';
import {
  REQUESTED_PACK_IDS,
  requestedChecks,
  requestedDefinitions,
  requestedDocument,
} from './requestedCatalog.js';

test('requested badge configuration imports and each rule holds', () => {
  const parsed = parseBadgeConfig(JSON.stringify(requestedDocument));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const prepared = validateBadgeConfig(parsed.document, REQUESTED_PACK_IDS);
  assert.equal(prepared.ok, true, prepared.errors.slice(0, 12).join('\n'));
  assert.equal(prepared.definitions.length, requestedDefinitions.length);

  const bySlug = new Map(prepared.definitions.map((definition) => [definition.slug, definition]));
  const covered = new Set<string>();
  const failures: string[] = [];
  requestedChecks.forEach((check, index) => {
    covered.add(check.slug);
    const definition = bySlug.get(check.slug);
    if (!definition) {
      failures.push(`${check.slug} is missing from the catalog`);
      return;
    }
    const result = evaluateBadge({ ...definition, id: 1 }, check.build());
    if (result.tier !== check.tier) {
      failures.push(`${check.slug} #${index} tier ${result.tier} credit ${result.credit}, expected tier ${check.tier}`);
    } else if (check.credit != null && Math.abs(result.credit - check.credit) > 1e-9) {
      failures.push(`${check.slug} #${index} credit ${result.credit}, expected ${check.credit}`);
    }
  });
  for (const definition of prepared.definitions) {
    if (!covered.has(definition.slug)) failures.push(`${definition.slug} has no fixture`);
  }
  assert.equal(failures.length, 0, failures.slice(0, 25).join('\n'));
});
