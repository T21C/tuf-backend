import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateBadge, type ChartFact, type OwnerInput, type PassFact, type WorldPass } from './evaluate.js';
import { emptyJudgements } from './judgement.js';
import { normalizeDefinition } from './params.js';
import { parseValueExpr } from './valueExpr.js';

function pass(partial: Partial<PassFact> & Pick<PassFact, 'id' | 'levelId'>): PassFact {
  return {
    playerId: 7,
    speed: 1,
    keyCount: null,
    vidUploadTime: '2024-06-01T00:00:00.000Z',
    uploadTimeKnown: true,
    createdAt: '2024-06-01T00:00:00.000Z',
    accuracy: 0.99,
    scoreV2: 100,
    isWorldsFirst: false,
    isWorldsFirstPP: false,
    isXPerfectMode: false,
    ancient: false,
    judgements: emptyJudgements(),
    difficultyAtName: 'G10',
    difficultyNowName: 'G10',
    difficultySource: 'history',
    durationMs: null,
    ...partial,
  };
}

function chart(id: number, diffName = 'G10'): ChartFact {
  return {
    id,
    diffName,
    songId: id,
    song: null,
    artistIds: [],
    durationMs: null,
    curationNames: [],
    charterIds: [],
    vfxerIds: [],
    clears: 0,
    isReference: false,
    curationCounts: true,
  };
}

function owner(partial: Partial<OwnerInput> = {}): OwnerInput {
  return {
    ownerId: 7,
    userId: null,
    passes: [],
    charts: [],
    links: {},
    sets: {},
    packLevels: {},
    reviews: [],
    ratings: [],
    world: [],
    frozenIds: null,
    since: null,
    ...partial,
  };
}

function valueBadge(expression: string, extra: Record<string, unknown> = {}) {
  const normalized = normalizeDefinition({
    audience: 'player',
    slug: 'value-badge',
    name: 'Value badge',
    reducer: 'value',
    grant: 'live',
    identity: 'level',
    backfill: 'now',
    curve: { start: 1, step: 1, round: 'none', direction: 'up' },
    params: { expression },
    ...extra,
  });
  assert.equal(normalized.ok, true, normalized.ok ? '' : normalized.errors.join('; '));
  if (!normalized.ok) throw new Error('normalize failed');
  return { ...normalized.value, id: 1 };
}

test('a value expression can require 75% of one difficulty', () => {
  const expression = 'result(difficulty("G10").total >= 8 && difficulty("G10").ratio >= 0.75 ? 1 : 0, difficulty("G10").cleared, 0, difficulty("G10").total)';
  const def = valueBadge(expression);
  const charts = Array.from({ length: 8 }, (_, index) => chart(index + 1));
  const six = evaluateBadge(def, owner({
    charts,
    passes: charts.slice(0, 6).map((item) => pass({ id: item.id, levelId: item.id })),
  }));
  const five = evaluateBadge(def, owner({
    charts,
    passes: charts.slice(0, 5).map((item) => pass({ id: item.id, levelId: item.id })),
  }));
  const tooFew = evaluateBadge(def, owner({
    charts: charts.slice(0, 7),
    passes: charts.slice(0, 7).map((item) => pass({ id: item.id, levelId: item.id })),
  }));
  assert.equal(six.tier, 1);
  assert.equal(six.credit, 6);
  assert.equal(five.tier, 0);
  assert.equal(tooFew.tier, 0);
});

test('difficulty stats ignore other difficulties and reuse one chart index', () => {
  const expression = 'result(difficulty("U6").total >= 8 && difficulty("U6").ratio >= 0.75 ? 1 : 0, difficulty("U6").cleared, 0, difficulty("U6").total)';
  const def = valueBadge(expression);
  const u6 = Array.from({ length: 8 }, (_, index) => chart(index + 1, 'U6'));
  const other = Array.from({ length: 40 }, (_, index) => chart(100 + index, index % 2 ? 'G10' : 'U7'));
  const result = evaluateBadge(def, owner({
    charts: [...other, ...u6],
    passes: u6.slice(0, 6).map((item) => pass({ id: item.id, levelId: item.id })),
  }));
  assert.equal(result.tier, 1);
  assert.equal(result.credit, 6);
  assert.equal(result.barTo, 8);
});

test('difficulty identities collapse chart subgroups', () => {
  const expression = 'result(1, difficulty("U6").cleared, 0, difficulty("U6").total)';
  const def = valueBadge(expression, { identity: 'chartSubgroup', grant: 'persistSnapshot' });
  const result = evaluateBadge(def, owner({
    charts: [chart(10, 'U6'), chart(11, 'U6'), chart(12, 'U6')],
    links: {
      10: { groupId: 1, chartSubgroup: 2, vfxSubgroup: null },
      11: { groupId: 1, chartSubgroup: 2, vfxSubgroup: null },
    },
    passes: [pass({ id: 1, levelId: 10 })],
  }));
  assert.equal(result.credit, 1);
  assert.equal(result.barTo, 2);
  assert.deepEqual(result.snapshotIds?.slice().sort((a, b) => a - b), [10, 11, 12]);
});

test('frozen difficulty snapshots keep the original chart set', () => {
  const expression = 'result(difficulty("U6").total >= 8 && difficulty("U6").ratio >= 0.75 ? 1 : 0, difficulty("U6").cleared, 0, difficulty("U6").total)';
  const def = valueBadge(expression, { grant: 'persistSnapshot' });
  const original = Array.from({ length: 8 }, (_, index) => chart(index + 1, 'U6'));
  const later = [...original, chart(9, 'U6'), chart(10, 'U6')];
  const result = evaluateBadge(def, owner({
    charts: later,
    passes: original.slice(0, 6).map((item) => pass({ id: item.id, levelId: item.id })),
    frozenIds: original.map((item) => item.id),
  }));
  assert.equal(result.tier, 1);
  assert.equal(result.credit, 6);
  assert.equal(result.barTo, 8);
});

test('sequence and consecutive walk clears in upload order', () => {
  const charts = [chart(10), chart(11), chart(12)];
  const passes = [
    pass({ id: 1, levelId: 10, vidUploadTime: '2024-01-01T00:00:00.000Z' }),
    pass({ id: 2, levelId: 99, vidUploadTime: '2024-01-02T00:00:00.000Z' }),
    pass({ id: 3, levelId: 11, vidUploadTime: '2024-01-03T00:00:00.000Z' }),
    pass({ id: 4, levelId: 12, vidUploadTime: '2024-01-04T00:00:00.000Z' }),
  ];
  const input = owner({ charts, passes });
  const loose = evaluateBadge(valueBadge('curve(sequence([10, 11, 12]), 3, 1)'), input);
  const strict = evaluateBadge(valueBadge('curve(consecutive([10, 11, 12]), 3, 1)'), input);
  assert.equal(loose.credit, 3);
  assert.equal(loose.tier, 1);
  assert.equal(strict.credit, 1);
  assert.equal(strict.tier, 0);
});

test('placeholder sheets do not satisfy judgement expressions', () => {
  const def = valueBadge('count(clears.filter(clear => clear.purePerfect == true))');
  const result = evaluateBadge(def, owner({
    charts: [chart(1)],
    passes: [pass({
      id: 1,
      levelId: 1,
      ancient: true,
      accuracy: 1,
      judgements: { ...emptyJudgements(), ePerfect: 5, perfect: 40, lPerfect: 5 },
    })],
  }));
  assert.equal(result.tier, 0);
  assert.equal(result.credit, 0);
});

test('nth and lead read the other clears of a chart', () => {
  const world: WorldPass[] = Array.from({ length: 3 }, (_, index) => ({
    passId: index + 1,
    playerId: index === 2 ? 7 : 100 + index,
    levelId: 4,
    vidUploadTime: `2024-01-0${index + 1}T00:00:00.000Z`,
    uploadTimeKnown: true,
    accuracy: index === 2 ? 0.99 : 0.9,
    scoreV2: 10,
    speed: 1,
    isWorldsFirst: index === 0,
    ancient: false,
  }));
  const input = owner({
    charts: [chart(4, 'G2')],
    world,
  });
  assert.equal(evaluateBadge(valueBadge('curve(nth(3), 1, 100000)'), input).tier, 1);
  assert.equal(evaluateBadge(valueBadge('count(levels.filter(level => lead(level, "accuracy")))'), input).credit, 1);
});

test('expressions cannot reach object internals', () => {
  const parsed = parseValueExpr('clears.filter(clear => clear.constructor)');
  assert.equal(parsed.ok, false);
  const def = valueBadge('count(clears.filter(clear => clear["constructor"]))');
  const result = evaluateBadge(def, owner({
    charts: [chart(1)],
    passes: [pass({ id: 1, levelId: 1 })],
  }));
  assert.equal(result.tier, 0);
});

const ACC_FARMER = 'curve(maxCount(clears, "identity"), 10, 100000)';
const GU_X100 = 'curve(maxCount(clears.filter(clear => clear.familyAt == "G" || clear.familyAt == "U"), "identity"), 100, 100000)';
const OBSESSED = 'curve(maxGroup(clears, "songId", "identity"), 10, 100000)';

test('maxCount is the most times one chart was cleared', () => {
  const charts = [chart(1, 'G10'), chart(2, 'U1'), chart(3, 'P1')];
  const passes = [
    ...Array.from({ length: 12 }, (_, index) => pass({
      id: index + 1,
      levelId: 1,
      difficultyAtName: 'G10',
      difficultyNowName: 'P1',
    })),
    ...Array.from({ length: 4 }, (_, index) => pass({
      id: 20 + index,
      levelId: 2,
      difficultyAtName: 'U1',
      difficultyNowName: 'U1',
    })),
    ...Array.from({ length: 8 }, (_, index) => pass({
      id: 40 + index,
      levelId: 3,
      difficultyAtName: 'P1',
      difficultyNowName: 'P1',
    })),
  ];
  const input = owner({ charts, passes });
  const farmer = evaluateBadge(valueBadge(ACC_FARMER), input);
  const gu = evaluateBadge(valueBadge(GU_X100), input);
  assert.equal(farmer.credit, 12);
  assert.equal(gu.credit, 12);
  assert.deepEqual(gu.provingPassIds.slice().sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index + 1));
});

test('maxGroup is the most distinct charts of one song', () => {
  const charts = [
    { ...chart(1, 'G1'), songId: 9 },
    { ...chart(2, 'G1'), songId: 9 },
    { ...chart(3, 'G1'), songId: 9 },
    { ...chart(4, 'P1'), songId: 8 },
    { ...chart(5, 'P1'), songId: 8 },
  ];
  const passes = [
    pass({ id: 1, levelId: 1 }),
    pass({ id: 2, levelId: 2 }),
    pass({ id: 3, levelId: 3 }),
    pass({ id: 4, levelId: 3 }),
    pass({ id: 5, levelId: 4 }),
    pass({ id: 6, levelId: 5 }),
  ];
  const result = evaluateBadge(valueBadge(OBSESSED), owner({ charts, passes }));
  assert.equal(result.credit, 3);
});

test('reclear badges stay cheap with a thousand P-band clears', () => {
  const charts = Array.from({ length: 200 }, (_, index) => chart(index + 1, 'P1'));
  const passes = Array.from({ length: 1300 }, (_, index) => pass({
    id: index + 1,
    levelId: (index % 200) + 1,
    difficultyAtName: 'P1',
    difficultyNowName: 'P1',
  }));
  const input = owner({ charts, passes });
  const started = Date.now();
  const farmer = evaluateBadge(valueBadge(ACC_FARMER), input);
  const gu = evaluateBadge(valueBadge(GU_X100), input);
  const elapsed = Date.now() - started;
  assert.equal(farmer.credit, 7);
  assert.equal(gu.credit, 0);
  assert.ok(elapsed < 500, `took ${elapsed}ms`);
});
