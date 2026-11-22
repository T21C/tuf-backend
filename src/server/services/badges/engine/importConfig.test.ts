import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBadgeConfig, validateBadgeConfig } from './importConfig.js';

test('exported dump rows with grantMode upsert by slug', () => {
  const parsed = parseBadgeConfig({
    groups: [{ id: 8, name: 'World', sortOrder: 2 }],
    definitions: [{
      slug: 'three-digit',
      name: '3 Digit!',
      audience: 'player',
      reducer: 'value',
      grantMode: 'live',
      identityMode: 'level',
      confirmMode: 'none',
      backfill: 'forward',
      curve: { start: 1, step: 1, round: 'none', direction: 'up' },
      params: { expression: 'curve(nth(100), 1, 100000)' },
      groupId: 8,
      sortOrder: 3,
      secret: true,
      enabled: true,
      weight: 1,
      display: { icon: null, stat: 'barThenNumber', color: null, purple: false, description: 'Be 100th.' },
      tierLabels: [],
    }],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const prepared = validateBadgeConfig(parsed.document);
  assert.equal(prepared.ok, true, prepared.errors.join('; '));
  assert.equal(prepared.groups[0]?.name, 'World');
  assert.equal(prepared.definitions[0]?.grant, 'live');
  assert.equal(prepared.definitions[0]?.identity, 'level');
  assert.equal(prepared.definitions[0]?.confirm, 'none');
  assert.equal(prepared.definitions[0]?.groupId, 8);
  assert.equal(prepared.definitions[0]?.sortOrder, 3);
});
