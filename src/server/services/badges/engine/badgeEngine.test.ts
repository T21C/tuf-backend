import assert from 'node:assert/strict';
import test from 'node:test';
import { barForCredit, labelForTier, shownRequirement, tierForCredit } from './curve.js';
import { difficultyAt, isUnknownUploadTime } from './difficultyAt.js';
import { evaluateBadge, packMembership, type ChartFact, type OwnerInput, type PassFact } from './evaluate.js';
import { identityKey } from './identity.js';
import { emptyJudgements, isAncientPlaceholder, isPpMinusOne } from './judgement.js';
import { formulaMatches, parseFormula } from './formula.js';
import { normalizeDefinition, type BadgeDraft } from './params.js';

function curve(direction: 'up' | 'down' = 'up', start = 1, step = 0.5) {
  return { start, step, round: 'none' as const, direction };
}

function pass(partial: Partial<PassFact> & Pick<PassFact, 'id' | 'levelId'>): PassFact {
  return {
    playerId: 7,
    speed: 1,
    keyCount: null,
    vidUploadTime: '2024-01-01T00:00:00.000Z',
    uploadTimeKnown: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    accuracy: 0.99,
    scoreV2: 100,
    isWorldsFirst: false,
    isWorldsFirstPP: false,
    isXPerfectMode: false,
    ancient: false,
    judgements: emptyJudgements(),
    difficultyAtName: 'G1',
    difficultyNowName: 'G1',
    difficultySource: 'current',
    durationMs: null,
    ...partial,
  };
}

function chart(id: number, diffName = 'G1'): ChartFact {
  return {
    id,
    diffName,
    songId: id,
    artistIds: [1],
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

function draft(reducer: BadgeDraft['reducer'], params: BadgeDraft['params'], extra: Partial<BadgeDraft> = {}): BadgeDraft {
  const normalized = normalizeDefinition({
    audience: 'player',
    slug: reducer,
    name: reducer,
    reducer,
    grant: 'live',
    identity: 'level',
    backfill: 'now',
    params,
    ...extra,
  });
  assert.equal(normalized.ok, true);
  if (!normalized.ok) throw new Error('invalid draft');
  normalized.value.id = 1;
  return normalized.value;
}

test('curve tiers land on half steps and ceil only changes the shown requirement', () => {
  const up = curve('up', 1, 0.5);
  assert.equal(tierForCredit(up, 1), 1);
  assert.equal(tierForCredit(up, 1.5), 2);
  assert.equal(tierForCredit(up, 2), 3);
  assert.equal(shownRequirement({ ...up, round: 'ceil' }, 2), 2);
  const down = curve('down', 4, 1);
  assert.equal(tierForCredit(down, 5), 0);
  assert.equal(tierForCredit(down, 4), 1);
  assert.equal(tierForCredit(down, 3), 2);
  assert.equal(tierForCredit(down, 1), 4);
  const bar = barForCredit(up, 1.25, 1);
  assert.equal(bar.from, 1);
  assert.equal(bar.to, 1.5);
});

test('tier labels pick the highest minTier at or below the earned tier', () => {
  const labels = [
    { minTier: 1, label: 'common' },
    { minTier: 4, label: 'legendary' },
  ];
  assert.equal(labelForTier(labels, 0), null);
  assert.equal(labelForTier(labels, 3), 'common');
  assert.equal(labelForTier(labels, 4), 'legendary');
});

test('pp-1 is one judgement outside the perfect band and zero misses', () => {
  const sheet = emptyJudgements();
  sheet.perfect = 10;
  sheet.ePerfect = 1;
  assert.equal(isPpMinusOne(sheet, false), true);
  sheet.earlyDouble = 1;
  sheet.ePerfect = 0;
  assert.equal(isPpMinusOne(sheet, false), false);
  const xmode = emptyJudgements();
  xmode.perfect = 4;
  xmode.perfectPlus = 1;
  xmode.ePerfect = 1;
  assert.equal(isPpMinusOne(xmode, true), true);
});

test('placeholder sheets are ignored by judgement badges', () => {
  const ancient = emptyJudgements();
  ancient.ePerfect = 5;
  ancient.perfect = 40;
  ancient.lPerfect = 5;
  assert.equal(isAncientPlaceholder(ancient), true);
  const result = evaluateBadge(
    draft('pattern', { ppMinusOne: true }),
    owner({
      passes: [pass({ id: 1, levelId: 3, ancient: true, judgements: ancient })],
      charts: [chart(3)],
    }),
  );
  assert.equal(result.tier, 0);
  assert.equal(result.skipPlaceholder, 1);
});

test('chart subgroup identity collapses linked charts and keeps each clear on its own chart', () => {
  const links = {
    10: { groupId: 1, chartSubgroup: 2, vfxSubgroup: null },
    11: { groupId: 1, chartSubgroup: 2, vfxSubgroup: null },
  };
  assert.equal(identityKey('chartSubgroup', 10, links[10]), identityKey('chartSubgroup', 11, links[11]));
  assert.notEqual(identityKey('level', 10, links[10]), identityKey('level', 11, links[11]));
  const collapsed = packMembership([10, 11], 'chartSubgroup', links, new Set([10]));
  assert.equal(collapsed.required.length, 1);
  assert.equal(collapsed.cleared, 1);
  const separate = packMembership([10, 11], 'level', links, new Set([10]));
  assert.equal(separate.required.length, 2);
  assert.equal(separate.cleared, 1);
});

test('difficultyAt walks rerate history and falls back to the snapshot', () => {
  const fromHistory = difficultyAt({
    vidUploadTime: '2024-01-01T00:00:00.000Z',
    history: [{
      createdAt: '2025-08-01T00:00:00.000Z',
      previousDiffId: 4,
      newDiffId: 9,
    }],
    snapshotDiffId: 3,
    currentDiffId: 9,
  });
  assert.deepEqual(fromHistory, { diffId: 4, source: 'history' });
  const later = difficultyAt({
    vidUploadTime: '2025-09-01T00:00:00.000Z',
    history: [{
      createdAt: '2025-08-01T00:00:00.000Z',
      previousDiffId: 4,
      newDiffId: 9,
    }],
    snapshotDiffId: null,
    currentDiffId: 1,
  });
  assert.deepEqual(later, { diffId: 9, source: 'history' });
  const snapshot = difficultyAt({
    vidUploadTime: null,
    history: [],
    snapshotDiffId: 6,
    currentDiffId: 2,
  });
  assert.deepEqual(snapshot, { diffId: 6, source: 'snapshot' });
  assert.equal(isUnknownUploadTime('2023-07-27T07:27:27.000Z'), true);
  assert.equal(isUnknownUploadTime('2024-05-01T00:00:00.000Z'), false);
});

test('pack completion counts each public chart once', () => {
  const result = evaluateBadge(
    draft('pack', { packId: 4 }),
    owner({
      passes: [pass({ id: 1, levelId: 10 }), pass({ id: 2, levelId: 11 })],
      charts: [chart(10), chart(11), chart(12)],
      packLevels: { 4: [10, 11, 12, 11] },
    }),
  );
  assert.equal(result.tier, 0);
  assert.equal(result.credit, 2);
  assert.equal(result.barTo, 3);
});

test('excel formulas support AND, OR, IF, and field comparisons', () => {
  assert.equal(parseFormula('=AND(speed>=2, OR(family="G", family="U"))').ok, true);
  assert.equal(formulaMatches('=AND(speed>=2, family="G")', { speed: 2, family: 'G' }), true);
  assert.equal(formulaMatches('=AND(speed>=2, family="G")', { speed: 1, family: 'G' }), false);
  assert.equal(formulaMatches('=IF(keyCount<=4, TRUE, FALSE)', { keyCount: 4 }), true);
  assert.equal(formulaMatches('=IF(keyCount<=4, TRUE, FALSE)', { keyCount: 6 }), false);
  assert.equal(formulaMatches('=NOT(ISBLANK(keyCount))', { keyCount: null }), false);
  assert.equal(formulaMatches('=HAS("V3")', { curation: ['V3'] }), true);
  assert.equal(parseFormula('=nope=1').ok, false);
});

test('a threshold badge keeps only clears that match the formula', () => {
  const result = evaluateBadge(
    draft('threshold', { aggregate: 'countDistinct', expression: '=AND(speed>=2, family="G")' }),
    owner({
      passes: [
        pass({ id: 1, levelId: 1, speed: 2, difficultyNowName: 'G3', difficultyAtName: 'G3' }),
        pass({ id: 2, levelId: 2, speed: 2, difficultyNowName: 'U1', difficultyAtName: 'U1' }),
      ],
      charts: [chart(1, 'G3'), chart(2, 'U1')],
    }),
  );
  assert.equal(result.credit, 1);
});

test('params reject unknown keys and accept a descending key-count curve', () => {
  const bad = normalizeDefinition({
    audience: 'player',
    slug: 'lesser',
    name: 'Lesser',
    reducer: 'best',
    grant: 'live',
    identity: 'level',
    backfill: 'now',
    params: { metric: 'keyCount', sql: 'drop table passes' },
  });
  assert.equal(bad.ok, false);
  const good = normalizeDefinition({
    audience: 'player',
    slug: 'lesser',
    name: 'Lesser',
    reducer: 'best',
    grant: 'live',
    identity: 'level',
    backfill: 'now',
    curve: { start: 4, step: 1, round: 'none', direction: 'down' },
    tierLabels: [{ minTier: 1, label: 'common' }, { minTier: 4, label: 'legendary' }],
    params: { metric: 'keyCount', families: ['U'] },
  });
  assert.equal(good.ok, true);
});
