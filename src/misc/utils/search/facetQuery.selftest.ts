/**
 * Run: npx tsx src/misc/utils/search/facetQuery.selftest.ts
 */
import assert from 'node:assert/strict';
import {
  parseFacetQueryString,
  buildFacetDomainClause,
  combineFacetClauses,
} from '@/misc/utils/search/facetQuery.js';

function run() {
  const raw = JSON.stringify({
    v: 1,
    combine: 'and',
    tags: { mode: 'simple', op: 'or', ids: [1, 2] },
    curationTypes: { mode: 'simple', op: 'or', ids: [3] },
  });
  const p = parseFacetQueryString(raw);
  assert.ok(p);
  assert.equal(p!.v, 1);
  assert.equal(p!.tags?.mode, 'simple');

  assert.equal(parseFacetQueryString(''), null);
  assert.equal(parseFacetQueryString('not-json'), null);
  assert.equal(parseFacetQueryString(JSON.stringify({ v: 2 })), null);

  const tagClause = buildFacetDomainClause(
    { mode: 'simple', op: 'or', ids: [10] },
    'tags',
    'tags.id'
  );
  assert.ok(tagClause && 'bool' in tagClause);

  const combined = combineFacetClauses(
    { bool: { must: [] } },
    { bool: { must: [] } },
    'and'
  );
  assert.ok(combined);

  const advPairs = JSON.stringify({
    v: 1,
    tags: {
      mode: 'advanced',
      groups: [
        { quantifier: 'all', ids: [1] },
        { quantifier: 'any', ids: [2, 3] },
      ],
      betweenGroups: 'and',
      betweenPairs: ['or'],
      excludeIds: [],
    },
  });
  const pp = parseFacetQueryString(advPairs);
  assert.ok(pp?.tags && pp.tags.mode === 'advanced');
  assert.equal((pp!.tags as { betweenPairs?: string[] }).betweenPairs?.[0], 'or');

  console.log('facetQuery.selftest: ok');
}

run();
