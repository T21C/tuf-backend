import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cachedOwnerDifficultyCounts,
  catalogDifficultyCoverage,
  frozenDifficultyCount,
  identitiesFromPasses,
  ownerDifficultyCounts,
} from './difficultyCoverage.js';

function chart(id: number, diffName: string) {
  return { id, diffName };
}

test('catalog coverage counts unique identities per difficulty once', () => {
  const charts = [
    chart(1, 'U6'),
    chart(2, 'U6'),
    chart(3, 'U6'),
    chart(4, 'G10'),
    chart(5, 'G10'),
  ];
  const links = {
    1: { groupId: 1, chartSubgroup: 2, vfxSubgroup: null },
    2: { groupId: 1, chartSubgroup: 2, vfxSubgroup: null },
  };
  const table = catalogDifficultyCoverage(charts, links, 'chartSubgroup');
  assert.equal(table.byName.get('U6')?.total, 2);
  assert.equal(table.byName.get('G10')?.total, 2);
  assert.equal(catalogDifficultyCoverage(charts, links, 'chartSubgroup'), table);
});

test('owner counts are a prepared list across every difficulty', () => {
  const charts = [
    chart(1, 'U6'),
    chart(2, 'U6'),
    chart(3, 'U6'),
    chart(4, 'U6'),
    chart(10, 'G10'),
    chart(11, 'G10'),
  ];
  const links = {};
  const table = catalogDifficultyCoverage(charts, links, 'level');
  const identities = identitiesFromPasses(table, links, [{ levelId: 1 }, { levelId: 2 }, { levelId: 10 }]);
  const counts = ownerDifficultyCounts(table, identities);
  assert.equal(counts.U6.total, 4);
  assert.equal(counts.U6.cleared, 2);
  assert.equal(counts.G10.cleared, 1);
  assert.equal(counts.G10.total, 2);
  const again = cachedOwnerDifficultyCounts(charts, links, 'level', [{ levelId: 1 }, { levelId: 2 }, { levelId: 10 }]);
  assert.equal(again.U6.cleared, 2);
});

test('frozen snapshots count only the captured charts', () => {
  const charts = [
    chart(1, 'U6'),
    chart(2, 'U6'),
    chart(3, 'U6'),
    chart(4, 'U6'),
  ];
  const links = {};
  const table = catalogDifficultyCoverage(charts, links, 'level');
  const identities = identitiesFromPasses(table, links, [{ levelId: 1 }, { levelId: 2 }, { levelId: 3 }]);
  const sliced = frozenDifficultyCount(table, 'U6', new Set([1, 2]), identities);
  assert.equal(sliced.count.total, 2);
  assert.equal(sliced.count.cleared, 2);
  assert.deepEqual(sliced.levelIds, [1, 2]);
});
