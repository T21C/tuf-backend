import type { ChartFact, OwnerInput, PassFact, WorldPass } from './evaluate.js';
import { emptyJudgements, type JudgementBuckets } from './judgement.js';

export const MIN_CHARTS = 8;
export const OFFICIAL_PACK = 'Official Levels';
export const CURSED_PACK = 'ADOFAI Cursed Levels';
export const REQUESTED_PACK_IDS: Record<string, number> = {
  [OFFICIAL_PACK]: 1,
  [CURSED_PACK]: 2,
};

const CREATOR = 3;
const GU = '(clear.familyAt == "G" || clear.familyAt == "U")';
const GUQ = '(clear.familyAt == "G" || clear.familyAt == "U" || clear.familyAt == "GQ" || clear.familyAt == "UQ" || clear.familyAt == "QQ")';

function tally(filter: string): string {
  return `count(distinct(clears.filter(clear => (${filter})), clear => clear.identity))`;
}

function curveOf(credit: string, start: number, step: number): string {
  return `curve(${credit}, ${start}, ${step})`;
}

type Raw = Record<string, unknown>;
type CheckBody = { tier: number; credit?: number; build: () => OwnerInput };

export type RequestedCheck = CheckBody & { slug: string };
export type RequestedSet = { name: string; kind: 'difficulty' | 'chart'; values: string[] };

function range(prefix: string, from: number, to: number): string[] {
  const out: string[] = [];
  for (let value = from; value <= to; value += 1) out.push(`${prefix}${value}`);
  return out;
}

export const REQUESTED_SETS: RequestedSet[] = [
  { name: 'planetary', kind: 'difficulty', values: range('P', 1, 20) },
  { name: 'galactic', kind: 'difficulty', values: range('G', 1, 20) },
  { name: 'universal', kind: 'difficulty', values: range('U', 1, 20) },
  { name: 'galactic-quantum', kind: 'difficulty', values: range('GQ', 0, 4) },
  { name: 'universal-quantum', kind: 'difficulty', values: range('UQ', 0, 4) },
  {
    name: 'end-to-end',
    kind: 'difficulty',
    values: ['P0', ...range('P', 1, 20), ...range('GQ', 0, 4), ...range('UQ', 0, 4), 'Impossible'],
  },
  {
    name: 'end-to-end-ex',
    kind: 'difficulty',
    values: [
      'P0', ...range('P', 1, 20), ...range('G', 1, 20), ...range('U', 1, 16),
      ...range('GQ', 0, 4), ...range('UQ', 0, 4), 'Censored', 'Impossible',
    ],
  },
];

const PGU = ['P0', ...range('P', 1, 20), ...range('G', 1, 20), ...range('U', 1, 20)];
const NON_Q = [...PGU, 'Impossible', 'Censored'];

const definitions: Raw[] = [];
const checks: RequestedCheck[] = [];
const slugs = new Set<string>();

function add(raw: Raw, check: CheckBody, extras: CheckBody[] = []) {
  const slug = String(raw.slug || '');
  if (!slug || slugs.has(slug)) throw new Error(`Duplicate or empty slug ${slug}`);
  slugs.add(slug);
  definitions.push(raw);
  checks.push({ slug, ...check });
  for (const extra of extras) checks.push({ slug, ...extra });
}

function badge(partial: Raw): Raw {
  const display = {
    icon: null,
    color: null,
    stat: 'barThenNumber',
    purple: false,
    ...(partial.display && typeof partial.display === 'object' ? partial.display as object : {}),
  };
  return {
    audience: 'player',
    grant: 'live',
    identity: 'level',
    backfill: 'now',
    secret: false,
    enabled: true,
    weight: 1,
    confirm: 'none',
    tierLabels: [],
    ...partial,
    reducer: 'value',
    curve: { start: 1, step: 1, round: 'none' as const, direction: 'up' as const },
    display,
  };
}

function purple(stat = 'barThenNumber') {
  return { icon: null, color: null, stat, purple: true };
}

function buckets(partial: Partial<JudgementBuckets> = {}): JudgementBuckets {
  return { ...emptyJudgements(), ...partial };
}

function atDay(day: number): string {
  return new Date(Date.UTC(2024, 0, 1) + day * 86400000).toISOString();
}

function chart(id: number, diffName = 'G1', extra: Partial<ChartFact> = {}): ChartFact {
  return {
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
    ...extra,
    id,
    diffName,
  };
}

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
    difficultyAtName: 'G1',
    difficultyNowName: 'G1',
    difficultySource: 'history',
    durationMs: null,
    ...partial,
  };
}

function world(partial: Partial<WorldPass> & Pick<WorldPass, 'passId' | 'playerId' | 'levelId'>): WorldPass {
  return {
    vidUploadTime: '2024-06-01T00:00:00.000Z',
    uploadTimeKnown: true,
    accuracy: 0.99,
    scoreV2: 100,
    speed: 1,
    isWorldsFirst: false,
    ancient: false,
    ...partial,
  };
}

function sets(): OwnerInput['sets'] {
  return Object.fromEntries(REQUESTED_SETS.map((set) => [set.name, { kind: set.kind, values: [...set.values] }]));
}

function owner(partial: Partial<OwnerInput> = {}): OwnerInput {
  return {
    ownerId: 7,
    userId: null,
    passes: [],
    charts: [],
    links: {},
    sets: sets(),
    packLevels: {},
    reviews: [],
    ratings: [],
    world: [],
    frozenIds: null,
    since: null,
    ...partial,
  };
}

function approved(passId = 1) {
  return [{ definitionId: 1, passId, status: 'approved' as const }];
}

function otherNow(name: string): string {
  return name.startsWith('P') && !name.startsWith('PP') ? 'G1' : 'P1';
}

function namedClear(name: string, extra: Partial<PassFact> = {}): OwnerInput {
  const now = otherNow(name);
  return owner({
    charts: [chart(1, now)],
    passes: [pass({ id: 1, levelId: 1, difficultyAtName: name, difficultyNowName: now, ...extra })],
  });
}

function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function difficultyClears(name: string, cleared: number, total: number): OwnerInput {
  const charts: ChartFact[] = [];
  const passes: PassFact[] = [];
  for (let index = 0; index < total; index += 1) {
    const id = 100 + index;
    charts.push(chart(id, name));
    if (index < cleared) {
      passes.push(pass({ id, levelId: id, difficultyAtName: name, difficultyNowName: name }));
    }
  }
  return owner({ charts, passes });
}

function linkedP1(): OwnerInput {
  const charts = [chart(1, 'P1'), chart(2, 'P1')];
  const links: OwnerInput['links'] = {
    1: { groupId: 1, chartSubgroup: 1, vfxSubgroup: null },
    2: { groupId: 1, chartSubgroup: 1, vfxSubgroup: null },
  };
  const passes = [pass({ id: 1, levelId: 1, difficultyAtName: 'P1', difficultyNowName: 'P1' })];
  for (let id = 3; id <= 9; id += 1) {
    charts.push(chart(id, 'P1'));
    if (id <= 7) passes.push(pass({ id, levelId: id, difficultyAtName: 'P1', difficultyNowName: 'P1' }));
  }
  return owner({ charts, passes, links });
}

function repeated(count: number, name: string, extra: Partial<PassFact> = {}): OwnerInput {
  const now = otherNow(name);
  return owner({
    charts: [chart(1, now)],
    passes: Array.from({ length: count }, (_, index) => pass({
      id: index + 1,
      levelId: 1,
      difficultyAtName: name,
      difficultyNowName: now,
      vidUploadTime: atDay(index),
      ...extra,
    })),
  });
}

function distinct(count: number, name: string, extra: Partial<PassFact> = {}): OwnerInput {
  return owner({
    charts: Array.from({ length: count }, (_, index) => chart(index + 1, name)),
    passes: Array.from({ length: count }, (_, index) => pass({
      id: index + 1,
      levelId: index + 1,
      difficultyAtName: name,
      difficultyNowName: name,
      vidUploadTime: atDay(index),
      ...extra,
    })),
  });
}

function credited(
  id: number,
  diff: string,
  curations: string[],
  role: 'charter' | 'vfxer' | 'both' = 'charter',
  extra: Partial<ChartFact> = {},
): ChartFact {
  return chart(id, diff, {
    curationNames: curations,
    charterIds: role === 'vfxer' ? [] : [CREATOR],
    vfxerIds: role === 'charter' ? [] : [CREATOR],
    ...extra,
  });
}

function creator(charts: ChartFact[]): OwnerInput {
  return owner({ ownerId: CREATOR, charts });
}

for (const name of NON_Q) {
  const slug = slugOf(name);
  add(badge({
    slug: `wf-${slug}`,
    name: `WF ${name}`,
    identity: 'chartSubgroup',
    params: { expression: curveOf(tally(`clear.worldsFirst == true && clear.difficultyAt == "${name}"`), 1, 100000) },
  }), {
    tier: 1,
    build: () => namedClear(name, { isWorldsFirst: true, speed: 1 }),
  }, name === 'P1' ? [{
    tier: 0,
    build: () => namedClear('P1', { isWorldsFirst: false, speed: 1 }),
  }] : []);

  add(badge({
    slug: `pp-${slug}`,
    name: `PP ${name}`,
    identity: 'chartSubgroup',
    params: { expression: curveOf(tally(`clear.purePerfect == true && clear.difficultyAt == "${name}"`), 1, 100000) },
  }), {
    tier: 1,
    build: () => namedClear(name, { accuracy: 1, judgements: buckets({ perfect: 80 }) }),
  }, name === 'P1' ? [{
    tier: 0,
    build: () => namedClear('P1', { accuracy: 1, ancient: true, judgements: buckets({ ePerfect: 5, perfect: 40, lPerfect: 5 }) }),
  }] : []);
}

for (const name of [...range('GQ', 0, 4), ...range('UQ', 0, 4), 'QQ']) {
  add(badge({
    slug: `pp-${slugOf(name)}`,
    name: `PP ${name}`,
    identity: 'chartSubgroup',
    params: { expression: curveOf(tally(`clear.purePerfect == true && clear.difficultyAt == "${name}"`), 1, 100000) },
  }), {
    tier: 1,
    build: () => namedClear(name, { accuracy: 1, judgements: buckets({ perfect: 80 }) }),
  });
}

for (const name of PGU) {
  add(badge({
    slug: `p75-${slugOf(name)}`,
    name: `${name} 75%`,
    grant: 'persistSnapshot',
    identity: 'chartSubgroup',
    reducer: 'percentOf',
    params: { expression: `result(difficulty("${name}").total >= ${MIN_CHARTS} && difficulty("${name}").ratio >= 0.75 ? 1 : 0, difficulty("${name}").cleared, 0, difficulty("${name}").total)` },
  }), {
    tier: 1,
    credit: 6,
    build: () => difficultyClears(name, 6, MIN_CHARTS),
  }, name === 'P1' ? [
    { tier: 0, build: () => difficultyClears('P1', 5, MIN_CHARTS) },
    { tier: 0, build: () => difficultyClears('P1', 7, 7) },
    { tier: 1, credit: 6, build: linkedP1 },
  ] : []);

  add(badge({
    slug: `pall-${slugOf(name)}`,
    name: `${name} All`,
    secret: true,
    grant: 'persistSnapshot',
    identity: 'chartSubgroup',
    reducer: 'percentOf',
    params: { expression: `result(difficulty("${name}").total >= ${MIN_CHARTS} && difficulty("${name}").ratio >= 1 ? 1 : 0, difficulty("${name}").cleared, 0, difficulty("${name}").total)` },
  }), {
    tier: 1,
    credit: MIN_CHARTS,
    build: () => difficultyClears(name, MIN_CHARTS, MIN_CHARTS),
  }, name === 'P1' ? [{ tier: 0, build: () => difficultyClears('P1', 7, MIN_CHARTS) }] : []);
}

const explorers = [
  ['explorer-planetary', 'Planetary Explorer', 'planetary'],
  ['explorer-galactic', 'Galactic Explorer', 'galactic'],
  ['explorer-universal', 'Universal Explorer', 'universal'],
  ['explorer-gq', 'Galactic Quantum Explorer', 'galactic-quantum'],
  ['explorer-uq', 'Universal Quantum Explorer', 'universal-quantum'],
] as const;

for (const [slug, name, setName] of explorers) {
  const first = REQUESTED_SETS.find((set) => set.name === setName)?.values[0] ?? 'P1';
  add(badge({
    slug,
    name,
    reducer: 'coverage',
    params: { expression: curveOf(`prefix("${setName}")`, 1, 1) },
  }), {
    tier: 1,
    build: () => owner({
      charts: [chart(1, 'Censored')],
      passes: [pass({ id: 1, levelId: 1, difficultyAtName: first, difficultyNowName: 'Censored' })],
    }),
  }, slug === 'explorer-planetary' ? [{
    tier: 0,
    build: () => namedClear('P2'),
  }] : []);
}

add(badge({
  slug: 'reference-guide',
  name: 'Reference Guide',
  grant: 'resetOnGrowth',
  reducer: 'coverage',
  params: { expression: 'result(count(levels.filter(level => level.reference == true)) > 0 && levels.filter(level => level.reference == true).every(level => clears.some(clear => clear.levelId == level.levelId)) ? 1 : 0, count(clears.filter(clear => clear.reference == true)), 0, count(levels.filter(level => level.reference == true)))' },
}), {
  tier: 1,
  build: () => owner({
    charts: [chart(4, 'P1', { isReference: true }), chart(5, 'G1', { isReference: true }), chart(6, 'U1')],
    passes: [pass({ id: 4, levelId: 4 }), pass({ id: 5, levelId: 5 })],
  }),
}, [{
  tier: 0,
  build: () => owner({
    charts: [chart(4, 'P1', { isReference: true }), chart(5, 'G1', { isReference: true })],
    passes: [pass({ id: 4, levelId: 4 })],
  }),
}]);

add(badge({
  slug: 'good-pc',
  name: 'This person has a good PC',
  grant: 'resetOnGrowth',
  reducer: 'coverage',
  params: { expression: 'result(count(levels.filter(level => level.curation.includes("V3"))) > 0 && levels.filter(level => level.curation.includes("V3")).every(level => clears.some(clear => clear.levelId == level.levelId)) ? 1 : 0, count(clears.filter(clear => clear.curation.includes("V3"))), 0, count(levels.filter(level => level.curation.includes("V3"))))' },
}), {
  tier: 1,
  build: () => owner({
    charts: [
      chart(4, 'G1', { curationNames: ['V3'] }),
      chart(5, 'U1', { curationNames: ['V3'] }),
      chart(6, 'P1', { curationNames: ['C3'] }),
    ],
    passes: [pass({ id: 4, levelId: 4 }), pass({ id: 5, levelId: 5 })],
  }),
}, [{
  tier: 0,
  build: () => owner({
    charts: [chart(4, 'G1', { curationNames: ['V3'] }), chart(5, 'U1', { curationNames: ['V3'] })],
    passes: [pass({ id: 4, levelId: 4 })],
  }),
}]);

const durations = [
  ['slow-burn', 'Slow Burn', 30 * 60 * 1000],
  ['heart-burn', 'Heart Burn', 60 * 60 * 1000],
  ['riding-the-bus', 'Riding the Bus', 8 * 60 * 60 * 1000],
  ['sisyphus', 'One Must Imagine Sisyphus Happy', 24 * 60 * 60 * 1000],
] as const;

for (const [slug, name, ms] of durations) {
  add(badge({
    slug,
    name,
    params: { expression: curveOf(`count(clears.filter(clear => clear.durationMs >= ${ms}))`, 1, 100000) },
  }), {
    tier: 1,
    build: () => owner({ passes: [pass({ id: 1, levelId: 1, durationMs: ms })], charts: [chart(1)] }),
  }, [{
    tier: 0,
    build: () => owner({ passes: [pass({ id: 1, levelId: 1, durationMs: ms - 1 })], charts: [chart(1)] }),
  }]);
}

add(badge({
  slug: 'perfect-match',
  name: 'Perfect Match!',
  reducer: 'pattern',
  display: purple('credit'),
  params: { expression: curveOf('shared()', 1, 100000) },
}), {
  tier: 1,
  build: () => owner({
    charts: [chart(1, 'G1'), chart(2, 'G4')],
    world: [
      world({ passId: 1, playerId: 7, levelId: 1, accuracy: 0.91234 }),
      world({ passId: 2, playerId: 8, levelId: 2, accuracy: 0.91234 }),
    ],
  }),
}, [
  {
    tier: 0,
    build: () => owner({
      charts: [chart(1, 'G1'), chart(2, 'G4')],
      world: [
        world({ passId: 1, playerId: 7, levelId: 1, accuracy: 0.91234 }),
        world({ passId: 2, playerId: 7, levelId: 2, accuracy: 0.91234 }),
      ],
    }),
  },
  {
    tier: 0,
    build: () => owner({
      charts: [chart(1, 'G1'), chart(2, 'U1')],
      world: [
        world({ passId: 1, playerId: 7, levelId: 1, accuracy: 0.95 }),
        world({ passId: 2, playerId: 8, levelId: 2, accuracy: 0.95 }),
      ],
    }),
  },
]);

const speedruns = [
  ['speedrun-p', 'Planetary Speedrun', 'P3'],
  ['speedrun-g', 'Galactic Speedrun', 'G3'],
  ['speedrun-u', 'Universal Speedrun', 'U3'],
  ['speedrun-gq', 'GQ Speedrun', 'GQ2'],
  ['speedrun-uq', 'UQ Speedrun', 'UQ2'],
] as const;

for (const [slug, name, sample] of speedruns) {
  const family = sample.startsWith('UQ') ? 'UQ' : sample.startsWith('GQ') ? 'GQ' : sample[0];
  add(badge({
    slug,
    name,
    identity: 'chartSubgroup',
    params: { expression: curveOf(tally(`clear.speed >= 2 && clear.familyAt == "${family}"`), 1, 100000) },
  }), {
    tier: 1,
    build: () => namedClear(sample, { speed: 2 }),
  }, slug === 'speedrun-p' ? [{ tier: 0, build: () => namedClear('P3', { speed: 1 }) }] : []);
}

add(badge({
  slug: 'archivist',
  name: 'Archivist',
  reducer: 'sequence',
  tierLabels: [{ minTier: 1, label: 'common' }],
  params: { expression: curveOf('blocks(10, "Impossible", "Censored")', 1, 1) },
}), {
  tier: 1,
  build: () => owner({
    charts: Array.from({ length: 10 }, (_, index) => chart(index + 1, index === 9 ? 'Censored' : 'P1')),
    passes: Array.from({ length: 9 }, (_, index) => pass({ id: index + 1, levelId: index + 1 })),
  }),
}, [{
  tier: 0,
  build: () => owner({
    charts: Array.from({ length: 10 }, (_, index) => chart(index + 1, 'P1')),
    passes: Array.from({ length: 9 }, (_, index) => pass({ id: index + 1, levelId: index + 1 })),
  }),
}]);

add(badge({
  slug: 'im-possible',
  name: 'Im Possible',
  identity: 'chartSubgroup',
  params: { expression: curveOf(tally('clear.difficultyAt == "Impossible"'), 1, 1) },
}), {
  tier: 1,
  build: () => namedClear('Impossible'),
}, [{
  tier: 0,
  build: () => owner({
    charts: [chart(1, 'Impossible')],
    passes: [pass({ id: 1, levelId: 1, difficultyAtName: 'P1', difficultyNowName: 'Impossible' })],
  }),
}]);

add(badge({
  slug: 'completionist',
  name: 'Completionist',
  identity: 'chartSubgroup',
  tierLabels: [{ minTier: 1, label: 'common' }, { minTier: 3, label: 'legendary' }],
  params: { expression: curveOf(tally('true'), 10, 20) },
}), { tier: 1, credit: 10, build: () => distinct(10, 'P1') }, [
  { tier: 0, build: () => distinct(9, 'P1') },
]);

add(badge({
  slug: 'hunter',
  name: 'Hunter',
  identity: 'chartSubgroup',
  params: { expression: curveOf(tally('clear.worldsFirst == true'), 10, 10) },
}), {
  tier: 1,
  build: () => distinct(10, 'G1', { isWorldsFirst: true, speed: 1 }),
}, [{ tier: 0, build: () => distinct(9, 'G1', { isWorldsFirst: true, speed: 1 }) }]);

add(badge({
  slug: 'gq-hunter',
  name: 'Galactic Quantum Hunter',
  identity: 'chartSubgroup',
  params: { expression: curveOf(tally('clear.worldsFirst == true && clear.familyAt == "GQ" && clear.noPriorClear == true'), 1, 1) },
}), {
  tier: 1,
  build: () => namedClear('GQ1', { isWorldsFirst: true, speed: 1 }),
}, [{
  tier: 0,
  build: () => owner({
    charts: [chart(1, 'P1')],
    passes: [
      pass({ id: 1, levelId: 1, vidUploadTime: atDay(0), difficultyAtName: 'GQ1', difficultyNowName: 'P1' }),
      pass({ id: 2, levelId: 1, vidUploadTime: atDay(1), isWorldsFirst: true, difficultyAtName: 'GQ1', difficultyNowName: 'P1' }),
    ],
  }),
}]);

add(badge({
  slug: 'uq-hunter',
  name: 'Universal Quantum Hunter',
  identity: 'chartSubgroup',
  params: { expression: curveOf(tally('clear.worldsFirst == true && clear.familyAt == "UQ" && clear.noPriorClear == true'), 1, 1) },
}), {
  tier: 1,
  build: () => namedClear('UQ1', { isWorldsFirst: true, speed: 1 }),
}, [{
  tier: 0,
  build: () => namedClear('UQ1', { isWorldsFirst: true, speed: 2 }),
}]);

add(badge({
  slug: 'acc-farmer',
  name: 'Acc Farmer',
  secret: true,
  identity: 'chartSubgroup',
  params: { expression: curveOf('max(clears.map(clear => count(clears.filter(other => other.identity == clear.identity))))', 10, 100000) },
}), { tier: 1, credit: 10, build: () => repeated(10, 'P1') }, [
  { tier: 0, credit: 9, build: () => repeated(9, 'P1') },
]);

add(badge({
  slug: 'gu-x100',
  name: 'G/U x100',
  secret: true,
  identity: 'chartSubgroup',
  params: { expression: curveOf(`max(clears.filter(clear => ${GU}).map(clear => count(clears.filter(other => other.identity == clear.identity && ${GU.replaceAll('clear.', 'other.')}))))`, 100, 100000) },
}), { tier: 1, build: () => repeated(100, 'G1') }, [
  { tier: 0, build: () => repeated(100, 'P1') },
]);

add(badge({
  slug: 'clearing-the-dust',
  name: 'Clearing the Dust',
  secret: true,
  reducer: 'gap',
  identity: 'chartSubgroup',
  display: { icon: null, color: null, stat: 'credit', purple: false },
  params: { expression: curveOf('gap()', 730, 100000) },
}), {
  tier: 1,
  credit: 730,
  build: () => {
    const start = Date.parse('2020-01-01T00:00:00.000Z');
    return owner({
      charts: [chart(1)],
      passes: [
        pass({ id: 1, levelId: 1, vidUploadTime: new Date(start).toISOString() }),
        pass({ id: 2, levelId: 1, vidUploadTime: new Date(start + 730 * 86400000).toISOString() }),
      ],
    });
  },
}, [{
  tier: 0,
  build: () => {
    const start = Date.parse('2020-01-01T00:00:00.000Z');
    return owner({
      charts: [chart(1)],
      passes: [
        pass({ id: 1, levelId: 1, vidUploadTime: new Date(start).toISOString() }),
        pass({ id: 2, levelId: 1, vidUploadTime: new Date(start + 729 * 86400000).toISOString() }),
      ],
    });
  },
}]);

add(badge({
  slug: 'relic-hunter',
  name: 'Relic Hunter',
  secret: true,
  reducer: 'chase',
  grant: 'chase',
  display: { icon: null, color: null, stat: 'credit', purple: false },
  params: { expression: 'result(min(levels.filter(level => level.difficulty != "Impossible" && level.difficulty != "Censored").map(level => level.levelId)) != null && clears.some(clear => clear.levelId == min(levels.filter(level => level.difficulty != "Impossible" && level.difficulty != "Censored").map(level => level.levelId))) ? 1 : 0, min(levels.filter(level => level.difficulty != "Impossible" && level.difficulty != "Censored" && !clears.some(clear => clear.levelId == level.levelId)).map(level => level.levelId)), 0, 1)' },
}), {
  tier: 1,
  credit: 5,
  build: () => owner({
    charts: [chart(1, 'Impossible'), chart(2, 'P1'), chart(3, 'Censored'), chart(5, 'G1')],
    passes: [pass({ id: 2, levelId: 2 })],
  }),
}, [{
  tier: 0,
  credit: 2,
  build: () => owner({
    charts: [chart(1, 'Impossible'), chart(2, 'P1'), chart(3, 'Censored'), chart(5, 'G1')],
  }),
}]);

add(badge({
  slug: 'three-digit',
  name: '3 Digit!',
  secret: true,
  reducer: 'nthClearer',
  params: { expression: curveOf('nth(100)', 1, 100000) },
}), {
  tier: 1,
  build: () => owner({
    charts: [chart(8, 'U1')],
    world: Array.from({ length: 100 }, (_, index) => world({
      passId: index + 1,
      playerId: index === 99 ? 7 : 2000 + index,
      levelId: 8,
      vidUploadTime: atDay(index),
    })),
  }),
}, [{
  tier: 0,
  build: () => owner({
    ownerId: 2000,
    charts: [chart(8, 'U1')],
    world: Array.from({ length: 100 }, (_, index) => world({
      passId: index + 1,
      playerId: index === 99 ? 7 : 2000 + index,
      levelId: 8,
      vidUploadTime: atDay(index),
    })),
  }),
}]);

add(badge({
  slug: 'obsessed',
  name: 'Obsessed',
  secret: true,
  identity: 'chartSubgroup',
  params: { expression: curveOf('max(clears.map(clear => count(distinct(clears.filter(other => other.songId == clear.songId), other => other.identity))))', 10, 100000) },
}), {
  tier: 1,
  build: () => owner({
    charts: Array.from({ length: 10 }, (_, index) => chart(index + 1, 'P1', { songId: 50 })),
    passes: Array.from({ length: 10 }, (_, index) => pass({ id: index + 1, levelId: index + 1 })),
  }),
}, [{
  tier: 0,
  build: () => owner({
    charts: Array.from({ length: 9 }, (_, index) => chart(index + 1, 'P1', { songId: 50 })),
    passes: Array.from({ length: 9 }, (_, index) => pass({ id: index + 1, levelId: index + 1 })),
  }),
}]);

add(badge({
  slug: 'perfectionist',
  name: 'Perfectionist',
  identity: 'chartSubgroup',
  tierLabels: [{ minTier: 1, label: 'common' }, { minTier: 10, label: 'legendary' }],
  params: { expression: curveOf(tally(`clear.purePerfect == true && ${GU}`), 1, 0.5) },
}), {
  tier: 1,
  build: () => namedClear('G2', { accuracy: 1, judgements: buckets({ perfect: 40 }) }),
}, [
  { tier: 0, build: () => namedClear('P2', { accuracy: 1, judgements: buckets({ perfect: 40 }) }) },
  {
    tier: 3,
    credit: 2,
    build: () => owner({
      charts: [chart(1, 'P1'), chart(2, 'P1')],
      passes: [
        pass({ id: 1, levelId: 1, accuracy: 1, difficultyAtName: 'G1', difficultyNowName: 'P1', judgements: buckets({ perfect: 10 }) }),
        pass({ id: 2, levelId: 2, accuracy: 1, difficultyAtName: 'U1', difficultyNowName: 'P1', judgements: buckets({ perfect: 10 }) }),
      ],
    }),
  },
  { tier: 0, build: () => namedClear('G2', { accuracy: 1, ancient: true }) },
]);

function recordHolder(diff: string, mine: number, other: number): OwnerInput {
  return owner({
    charts: [chart(4, diff)],
    world: [
      world({ passId: 1, playerId: 7, levelId: 4, accuracy: mine }),
      world({ passId: 2, playerId: 8, levelId: 4, accuracy: other }),
    ],
  });
}

add(badge({
  slug: 'sharpshooter-g',
  name: 'Galactic Sharpshooter',
  reducer: 'record',
  identity: 'chartSubgroup',
  params: { expression: curveOf('count(levels.filter(level => level.family == "G" && lead(level, "accuracy")))', 1, 1) },
}), { tier: 1, build: () => recordHolder('G4', 0.991, 0.94) }, [
  { tier: 0, build: () => recordHolder('G4', 0.9, 0.99) },
  { tier: 0, build: () => recordHolder('P4', 0.991, 0.9) },
]);

add(badge({
  slug: 'sharpshooter-u',
  name: 'Universal Sharpshooter',
  reducer: 'record',
  identity: 'chartSubgroup',
  params: { expression: curveOf('count(levels.filter(level => level.family == "U" && lead(level, "accuracy")))', 1, 1) },
}), { tier: 1, build: () => recordHolder('U4', 0.991, 0.94) });

function controlled(diff: string, others: number, mineWf = true): OwnerInput {
  const rows = [world({
    passId: 1,
    playerId: 7,
    levelId: 4,
    accuracy: 0.99,
    scoreV2: 500,
    speed: 3,
    isWorldsFirst: mineWf,
  })];
  for (let index = 0; index < others; index += 1) {
    rows.push(world({
      passId: index + 2,
      playerId: 100 + index,
      levelId: 4,
      scoreV2: 100,
      speed: 1,
    }));
  }
  return owner({ charts: [chart(4, diff)], world: rows });
}

add(badge({
  slug: 'absolute-control',
  name: 'Absolute Control',
  secret: true,
  reducer: 'record',
  params: { expression: curveOf('max(levels.filter(level => (level.family == "G" || level.family == "U") && lead(level, "accuracy") && lead(level, "score") && lead(level, "speed") && first(level)).map(level => level.rivals))', 5, 5) },
}), { tier: 1, credit: 5, build: () => controlled('G2', 5) }, [
  { tier: 0, credit: 4, build: () => controlled('G2', 4) },
  { tier: 0, build: () => controlled('G2', 5, false) },
  { tier: 0, build: () => controlled('P2', 5) },
]);

const ppMinus = buckets({ ePerfect: 1, perfect: 40 });

add(badge({
  slug: 'decimal-curse',
  name: 'Decimal Curse',
  secret: true,
  reducer: 'pattern',
  confirm: 'accuracyFull',
  params: { expression: curveOf('count(clears.filter(clear => clear.accuracyText.endsWith("31")))', 1, 100000) },
}), {
  tier: 1,
  build: () => owner({ charts: [chart(1)], passes: [pass({ id: 1, levelId: 1, accuracy: 0.9831 })] }),
}, [{
  tier: 0,
  build: () => owner({ charts: [chart(1)], passes: [pass({ id: 1, levelId: 1, accuracy: 0.9832 })] }),
}]);

add(badge({
  slug: 'so-close',
  name: 'So Close!',
  secret: true,
  reducer: 'pattern',
  confirm: 'judgementsFull',
  display: purple(),
  params: { expression: curveOf(tally(`clear.ppMinusOne == true && ${GU}`), 1, 100000) },
}), {
  tier: 1,
  build: () => namedClear('G3', { judgements: ppMinus, accuracy: 0.99 }),
}, [{ tier: 0, build: () => namedClear('P3', { judgements: ppMinus, accuracy: 0.99 }) }]);

add(badge({
  slug: 'icesans',
  name: 'Icesans',
  secret: true,
  reducer: 'pattern',
  params: { expression: curveOf('count(clears.filter(clear => clear.misses > 75))', 1, 100000) },
}), {
  tier: 1,
  credit: 1,
  build: () => owner({ passes: [pass({ id: 1, levelId: 1, judgements: buckets({ earlyDouble: 76, perfect: 10 }) })] }),
}, [{
  tier: 0,
  build: () => owner({ passes: [pass({ id: 1, levelId: 1, judgements: buckets({ earlyDouble: 75, perfect: 10 }) })] }),
}]);

add(badge({
  slug: 'how',
  name: 'How?',
  secret: true,
  reducer: 'pattern',
  display: purple(),
  params: { expression: curveOf(tally(`clear.noMisses == true && clear.accuracy < 0.97 && ${GUQ}`), 1, 100000) },
}), {
  tier: 1,
  build: () => namedClear('G1', { accuracy: 0.96, judgements: buckets({ earlySingle: 4, perfect: 20 }) }),
}, [
  { tier: 0, build: () => namedClear('G1', { accuracy: 0.98, judgements: buckets({ earlySingle: 4, perfect: 20 }) }) },
  { tier: 0, build: () => namedClear('G1', { accuracy: 0.9, judgements: buckets({ earlyDouble: 1, perfect: 20 }) }) },
]);

add(badge({
  slug: 'ocd',
  name: 'OCD Satisfaction',
  secret: true,
  reducer: 'pattern',
  display: purple(),
  params: { expression: curveOf('count(clears.filter(clear => clear.scoreText.endsWith("000")))', 1, 100000) },
}), {
  tier: 1,
  build: () => owner({ passes: [pass({ id: 1, levelId: 1, scoreV2: 100 })] }),
}, [{ tier: 0, build: () => owner({ passes: [pass({ id: 1, levelId: 1, scoreV2: 100.001 })] }) }]);

add(badge({
  slug: 'symmetry',
  name: 'Symmetry',
  secret: true,
  reducer: 'pattern',
  confirm: 'judgementsFull',
  display: purple(),
  params: { expression: curveOf(tally(`clear.symmetry == true && ${GUQ}`), 1, 100000) },
}), {
  tier: 1,
  build: () => namedClear('U2', {
    accuracy: 0.9,
    judgements: buckets({ ePerfect: 3, lPerfect: 3, earlySingle: 2, lateSingle: 2, perfect: 10 }),
  }),
}, [{
  tier: 0,
  build: () => namedClear('U2', { accuracy: 1, judgements: buckets({ perfect: 10 }) }),
}]);

add(badge({
  slug: 'technically-pure',
  name: 'Technically Pure Perfect?',
  secret: true,
  reducer: 'pattern',
  display: purple(),
  params: { expression: curveOf(tally(`clear.technicallyPure == true && ${GUQ}`), 1, 100000) },
}), {
  tier: 1,
  build: () => namedClear('G1', { judgements: buckets({ earlySingle: 2, lateSingle: 2, perfect: 5 }) }),
}, [{
  tier: 0,
  build: () => namedClear('G1', { judgements: buckets({ ePerfect: 1, earlySingle: 2, lateSingle: 2, perfect: 5 }) }),
}]);

add(badge({
  slug: 'pure-99995',
  name: 'Pure Perfect?????',
  secret: true,
  reducer: 'pattern',
  confirm: 'accuracyFull',
  display: purple(),
  params: { expression: curveOf(tally(`clear.accuracyText == "99.995" && ${GUQ}`), 1, 100000) },
}), {
  tier: 1,
  build: () => namedClear('G1', { accuracy: 0.99995 }),
}, [{ tier: 0, build: () => namedClear('G1', { accuracy: 1, judgements: buckets({ perfect: 20 }) }) }]);

add(badge({
  slug: 'pure-unperfect',
  name: 'Pure unPerfect?',
  secret: true,
  reducer: 'best',
  display: purple('credit'),
  params: { expression: `curveDown(min(clears.filter(clear => ${GUQ} && clear.perfects != null).map(clear => clear.perfects)), 0, 1)` },
}), {
  tier: 1,
  credit: 0,
  build: () => namedClear('G2', { judgements: buckets({ earlySingle: 4, lateSingle: 1 }) }),
}, [{
  tier: 0,
  credit: 4,
  build: () => namedClear('G2', { judgements: buckets({ perfect: 4, earlySingle: 1 }) }),
}]);

add(badge({
  slug: 'asymmetry',
  name: 'Asymmetry',
  secret: true,
  reducer: 'pattern',
  display: purple(),
  params: { expression: curveOf(tally(`clear.asymmetry == true && ${GUQ}`), 1, 100000) },
}), {
  tier: 1,
  build: () => namedClear('G1', { judgements: buckets({ earlySingle: 8, perfect: 2 }) }),
}, [{
  tier: 0,
  build: () => namedClear('G1', { judgements: buckets({ earlySingle: 1, perfect: 20 }) }),
}]);

add(badge({
  slug: 'gamma',
  name: 'Gamma',
  secret: true,
  reducer: 'pattern',
  confirm: 'judgementsFull',
  display: purple(),
  params: { expression: curveOf(tally(`(clear.earlies == 111 || clear.lates == 111 || clear.ePerfect == 111 || clear.lPerfect == 111 || clear.perfectMinus == 111 || clear.perfectPlus == 111) && ${GUQ}`), 1, 100000) },
}), {
  tier: 1,
  build: () => namedClear('U1', { judgements: buckets({ earlySingle: 111, perfect: 4 }) }),
}, [{
  tier: 0,
  build: () => namedClear('U1', { judgements: buckets({ perfect: 111 }) }),
}]);

add(badge({
  slug: 'wysi',
  name: 'WYSI',
  secret: true,
  reducer: 'pattern',
  confirm: 'accuracyFull',
  display: purple(),
  params: { expression: curveOf(tally(`clear.accuracyText.startsWith("72.7") && ${GUQ}`), 1, 100000) },
}), {
  tier: 1,
  build: () => namedClear('G1', { accuracy: 0.7273 }),
}, [{ tier: 0, build: () => namedClear('G1', { accuracy: 0.726 }) }]);

add(badge({
  slug: 'rating',
  name: 'Rating',
  params: { expression: curveOf('maxGroup(ratings, "week", "levelId")', 9, 6) },
}), {
  tier: 1,
  build: () => owner({
    ratings: Array.from({ length: 9 }, (_, index) => ({ levelId: index + 1, createdAt: '2024-01-08T12:00:00.000Z' })),
  }),
}, [
  { tier: 0, build: () => owner({ ratings: Array.from({ length: 8 }, (_, index) => ({ levelId: index + 1, createdAt: '2024-01-08T12:00:00.000Z' })) }) },
  { tier: 2, build: () => owner({ ratings: Array.from({ length: 15 }, (_, index) => ({ levelId: index + 1, createdAt: '2024-01-08T12:00:00.000Z' })) }) },
]);

const any3302 = '(clear.misses == 3302 || clear.earlies == 3302 || clear.ePerfect == 3302 || clear.perfect == 3302 || clear.lPerfect == 3302 || clear.lates == 3302 || clear.perfectMinus == 3302 || clear.perfectPlus == 3302)';

add(badge({
  slug: 'cicada3302',
  name: 'Cicada3302',
  reducer: 'pattern',
  confirm: 'judgementsFull',
  params: { expression: curveOf(`count(clears.filter(clear => clear.song == "Cicada3302" && ${any3302}))`, 1, 100000) },
}), {
  tier: 1,
  build: () => owner({
    charts: [chart(1, 'U1', { song: 'Cicada3302' })],
    passes: [pass({ id: 1, levelId: 1, judgements: buckets({ earlyDouble: 3302 }) })],
  }),
}, [{
  tier: 0,
  build: () => owner({
    charts: [chart(1, 'U1', { song: 'Cicada' })],
    passes: [pass({ id: 1, levelId: 1, judgements: buckets({ earlyDouble: 3302 }) })],
  }),
}]);

const origins = buckets({ earlyDouble: 6, earlySingle: 17, ePerfect: 46, perfect: 4910, lPerfect: 24, lateSingle: 15 });
const aion = buckets({ earlySingle: 1, ePerfect: 6, perfect: 1834, lPerfect: 2 });

add(badge({
  slug: 'origins',
  name: 'Origins',
  reducer: 'pattern',
  confirm: 'judgementsFull',
  params: { expression: 'curve(count(clears.filter(clear => clear.levelId == 1 && clear.misses == 6 && clear.earlies == 17 && clear.ePerfect == 46 && clear.perfect == 4910 && clear.lPerfect == 24 && clear.lates == 15 && clear.perfectMinus == 0 && clear.perfectPlus == 0)), 1, 100000)' },
}), {
  tier: 1,
  build: () => owner({ charts: [chart(1, 'P1')], passes: [pass({ id: 1, levelId: 1, judgements: origins })] }),
}, [
  { tier: 0, build: () => owner({ passes: [pass({ id: 1, levelId: 1, judgements: buckets({ perfect: 1 }) })] }) },
  { tier: 0, build: () => owner({ passes: [pass({ id: 1, levelId: 1, ancient: true, judgements: origins })] }) },
]);

add(badge({
  slug: 'decimal-curse-v2',
  name: 'Decimal Curse V2',
  reducer: 'pattern',
  confirm: 'judgementsFull',
  params: { expression: 'curve(count(clears.filter(clear => clear.levelId == 8017 && clear.misses == 0 && clear.earlies == 1 && clear.ePerfect == 6 && clear.perfect == 1834 && clear.lPerfect == 2 && clear.lates == 0 && clear.perfectMinus == 0 && clear.perfectPlus == 0)), 1, 100000)' },
}), {
  tier: 1,
  build: () => owner({ charts: [chart(8017)], passes: [pass({ id: 1, levelId: 8017, judgements: aion })] }),
}, [{ tier: 0, build: () => owner({ passes: [pass({ id: 1, levelId: 1, judgements: aion })] }) }]);

add(badge({
  slug: 'washing-machine',
  name: 'Washing Machine',
  reducer: 'sequence',
  params: { expression: 'result(sequence([5017, 52]) == 2 ? 1 : 0, sequence([5017, 52]), 0, 2)' },
}), {
  tier: 1,
  build: () => owner({
    passes: [
      pass({ id: 1, levelId: 5017, vidUploadTime: atDay(1) }),
      pass({ id: 2, levelId: 9, vidUploadTime: atDay(2) }),
      pass({ id: 3, levelId: 52, vidUploadTime: atDay(3) }),
    ],
  }),
}, [{
  tier: 0,
  build: () => owner({
    passes: [
      pass({ id: 1, levelId: 52, vidUploadTime: atDay(1) }),
      pass({ id: 2, levelId: 5017, vidUploadTime: atDay(2) }),
    ],
  }),
}]);

const jippLevels = [264, 11063, 7740, 12290];

add(badge({
  slug: 'jipp-1er',
  name: 'Jipp-1er',
  reducer: 'sequence',
  params: { expression: 'result(consecutive([264, 11063, 7740, 12290], clear => clear.ppMinusOne == true) == 4 ? 1 : 0, consecutive([264, 11063, 7740, 12290], clear => clear.ppMinusOne == true), 0, 4)' },
}), {
  tier: 1,
  build: () => owner({
    passes: jippLevels.map((levelId, index) => pass({
      id: index + 1,
      levelId,
      vidUploadTime: atDay(index),
      judgements: ppMinus,
    })),
  }),
}, [
  {
    tier: 0,
    build: () => owner({
      passes: [...jippLevels].reverse().map((levelId, index) => pass({
        id: index + 1,
        levelId,
        vidUploadTime: atDay(index),
        judgements: ppMinus,
      })),
    }),
  },
  {
    tier: 0,
    build: () => owner({
      passes: jippLevels.map((levelId, index) => pass({
        id: index + 1,
        levelId,
        vidUploadTime: atDay(index),
        judgements: buckets({ earlyDouble: 1, perfect: 10 }),
      })),
    }),
  },
]);

add(badge({
  slug: 'wysi-day',
  name: 'WYSI Day',
  reducer: 'pattern',
  params: { expression: 'curve(count(clears.filter(clear => clear.month == 7 && clear.day == 27 && clear.song == "WYSI")), 1, 100000)' },
}), {
  tier: 1,
  build: () => owner({
    charts: [chart(1, 'G1', { song: 'WYSI' })],
    passes: [pass({ id: 1, levelId: 1, vidUploadTime: '2024-07-27T15:00:00.000Z' })],
  }),
}, [{
  tier: 0,
  build: () => owner({
    charts: [chart(1, 'G1', { song: 'WYSI' })],
    passes: [pass({ id: 1, levelId: 1, vidUploadTime: '2024-07-26T15:00:00.000Z' })],
  }),
}]);

function reviewed(diffAt: string, diffNow: string, passId = 1, withReview = true): OwnerInput {
  return owner({
    charts: [chart(passId, diffNow)],
    passes: [pass({
      id: passId,
      levelId: passId,
      difficultyAtName: diffAt,
      difficultyNowName: diffNow,
    })],
    reviews: withReview ? approved(passId) : [],
  });
}

add(badge({
  slug: 'refraction',
  name: 'REFRACTION»«REFLECTION',
  reducer: 'manual',
  grant: 'manualLock',
  backfill: 'queue',
  params: { expression: 'curve(count(clears.filter(clear => clear.levelId == 10452)), 1, 100000)' },
}), {
  tier: 1,
  build: () => owner({
    charts: [chart(10452)],
    passes: [pass({ id: 1, levelId: 10452 })],
    reviews: approved(1),
  }),
}, [{
  tier: 0,
  build: () => owner({ charts: [chart(10452)], passes: [pass({ id: 1, levelId: 10452 })] }),
}]);

add(badge({
  slug: 'slide-left',
  name: 'Slide to the Left!',
  reducer: 'manual',
  grant: 'manualLock',
  backfill: 'queue',
  display: purple(),
  params: { expression: `curve(${tally(GU)}, 1, 100000)` },
}), { tier: 1, build: () => reviewed('G2', 'P1') }, [
  { tier: 0, build: () => reviewed('G2', 'P1', 1, false) },
  { tier: 0, build: () => reviewed('P2', 'G2') },
]);

add(badge({
  slug: 'slide-right',
  name: 'Slide to the Right!',
  reducer: 'manual',
  grant: 'manualLock',
  backfill: 'queue',
  display: purple(),
  params: { expression: `curve(${tally(GU)}, 1, 100000)` },
}), { tier: 1, build: () => reviewed('U2', 'P1') }, [
  { tier: 0, build: () => reviewed('U2', 'P1', 1, false) },
]);

add(badge({
  slug: 'mouse',
  name: 'Who Needs a Keyboard?',
  reducer: 'manual',
  grant: 'manualLock',
  backfill: 'queue',
  display: purple(),
  params: { expression: `curve(${tally(GU)}, 1, 100000)` },
}), { tier: 1, build: () => reviewed('G4', 'P1') }, [
  { tier: 0, build: () => reviewed('G4', 'P1', 1, false) },
]);

add(badge({
  slug: 'single-arm',
  name: 'Single_Arm',
  reducer: 'manual',
  grant: 'manualLock',
  backfill: 'queue',
  params: { expression: 'curve(count(clears.filter(clear => clear.levelId == 1)), 1, 100000)' },
}), { tier: 1, build: () => reviewed('P1', 'P1') }, [
  { tier: 0, build: () => reviewed('P1', 'P1', 1, false) },
]);

add(badge({
  slug: 'lesser-the-better',
  name: 'The Lesser the Better',
  reducer: 'best',
  display: purple('credit'),
  tierLabels: [{ minTier: 1, label: 'common' }, { minTier: 4, label: 'legendary' }],
  params: { expression: 'curveDown(min(clears.filter(clear => clear.familyAt == "U" && clear.keyCount != null).map(clear => clear.keyCount)), 4, 1)' },
}), {
  tier: 1,
  credit: 4,
  build: () => namedClear('U3', { keyCount: 4 }),
}, [
  { tier: 4, credit: 1, build: () => namedClear('U3', { keyCount: 1 }) },
  { tier: 0, build: () => namedClear('U3', { keyCount: 5 }) },
  { tier: 0, build: () => namedClear('P3', { keyCount: 1 }) },
]);

add(badge({
  slug: 'look-no-hands',
  name: 'Look! No Hands!',
  grant: 'manualLock',
  backfill: 'queue',
  display: purple(),
  params: { expression: curveOf(tally(GUQ), 1, 1) },
}), {
  tier: 1,
  build: () => reviewed('G1', 'P1'),
}, [
  { tier: 0, build: () => reviewed('G1', 'P1', 1, false) },
  { tier: 0, build: () => reviewed('P1', 'G1') },
  {
    tier: 2,
    build: () => owner({
      charts: [chart(1, 'P1'), chart(2, 'P1')],
      passes: [
        pass({ id: 1, levelId: 1, difficultyAtName: 'G1', difficultyNowName: 'P1' }),
        pass({ id: 2, levelId: 2, difficultyAtName: 'UQ1', difficultyNowName: 'P1' }),
      ],
      reviews: [...approved(1), { definitionId: 1, passId: 2, status: 'approved' as const }],
    }),
  },
]);

const packExpr = 'result(count(pack()) > 0 && pack().every(id => clears.some(clear => clear.levelId == id)) ? 1 : 0, count(pack().filter(id => clears.some(clear => clear.levelId == id))), 0, count(pack()))';

function packClear(packId: number, ids: number[], cleared: number[]): OwnerInput {
  const levels: Record<number, number[]> = { [packId]: ids };
  return owner({
    charts: ids.map((id) => chart(id, 'P1')),
    passes: cleared.map((id) => pass({ id, levelId: id })),
    packLevels: levels,
  });
}

add(badge({
  slug: 'thanks-for-playing',
  name: 'Thanks for Playing!',
  reducer: 'pack',
  grant: 'resetOnGrowth',
  params: { packName: OFFICIAL_PACK, expression: packExpr },
}), {
  tier: 1,
  build: () => packClear(REQUESTED_PACK_IDS[OFFICIAL_PACK], [10, 11], [10, 11]),
}, [{ tier: 0, build: () => packClear(REQUESTED_PACK_IDS[OFFICIAL_PACK], [10, 11], [10]) }]);

add(badge({
  slug: 'thinks-for-playing',
  name: 'Thinks for Playing?',
  reducer: 'pack',
  grant: 'resetOnGrowth',
  params: { packName: CURSED_PACK, expression: packExpr },
}), {
  tier: 1,
  build: () => packClear(REQUESTED_PACK_IDS[CURSED_PACK], [20, 21], [20, 21]),
}, [{ tier: 0, build: () => packClear(REQUESTED_PACK_IDS[CURSED_PACK], [20, 21], [21]) }]);

for (const name of ['V3', 'V2', 'V1', 'C3', 'C2', 'C1', 'O3', 'O2', 'O1'] as const) {
  const vfx = name.startsWith('V');
  const role = vfx ? 'ownerIsVfxer' : 'ownerIsCharter';
  const countField = vfx ? 'vfxerCount' : 'charterCount';
  const credit = name === 'V3'
    ? `sum(mine.filter(level => level.${role} == true && level.curation.includes("${name}")).map(level => level.${countField} <= 1 ? 1 : 0.5))`
    : `count(mine.filter(level => level.${role} == true && level.curation.includes("${name}")))`;
  const step = name === 'V3' ? 0.5 : name.endsWith('1') ? 2 : 1;
  add(badge({
    audience: 'creator',
    slug: name.toLowerCase(),
    name,
    params: { expression: curveOf(credit, 1, step) },
  }), {
    tier: 1,
    build: () => creator([credited(1, 'G1', [name], vfx ? 'vfxer' : 'charter')]),
  }, name === 'V3' ? [
    { tier: 0, credit: 0.5, build: () => creator([credited(1, 'G1', ['V3'], 'vfxer', { vfxerIds: [CREATOR, 9] })]) },
    {
      tier: 1,
      credit: 1,
      build: () => creator([
        credited(1, 'G1', ['V3'], 'vfxer', { vfxerIds: [CREATOR, 9] }),
        credited(2, 'U1', ['V3'], 'vfxer', { vfxerIds: [CREATOR, 8] }),
      ]),
    },
    {
      tier: 3,
      credit: 2,
      build: () => creator([
        credited(1, 'G1', ['V3'], 'vfxer'),
        credited(2, 'U1', ['V3'], 'vfxer'),
      ]),
    },
  ] : []);
}

for (const name of ['H2', 'H1', 'Epic'] as const) {
  add(badge({
    audience: 'creator',
    slug: name.toLowerCase(),
    name,
    params: { expression: curveOf(`count(mine.filter(level => level.curation.includes("${name}")))`, 1, 100000) },
  }), { tier: 1, build: () => creator([credited(1, 'G1', [name], 'both')]) });
}

add(badge({
  audience: 'creator',
  slug: 'vfx-master',
  name: 'VFX MASTER!!!!!',
  params: { expression: curveOf('count(mine.filter(level => level.ownerIsVfxer == true && level.vfxerCount == 1 && level.curation.includes("V3")))', 1, 1) },
}), { tier: 1, build: () => creator([credited(1, 'G1', ['V3'], 'vfxer')]) }, [
  { tier: 0, build: () => creator([credited(1, 'G1', ['V3'], 'vfxer', { vfxerIds: [CREATOR, 9] })]) },
]);

add(badge({
  audience: 'creator',
  slug: 'curation-collector',
  name: 'Curation Collector',
  reducer: 'coverage',
  params: { expression: 'result(mine.some(level => level.ownerIsCharter == true) && ["C1", "C2", "C3"].every(name => mine.some(level => level.curation.includes(name))) && (!mine.some(level => level.ownerIsVfxer == true) || ["V1", "V2", "V3"].every(name => mine.some(level => level.curation.includes(name)))) ? 1 : 0, 0, 0, 1)' },
}), {
  tier: 1,
  build: () => creator(['C1', 'C2', 'C3'].map((name, index) => credited(index + 1, 'P1', [name]))),
}, [{
  tier: 0,
  build: () => creator(['C1', 'C2'].map((name, index) => credited(index + 1, 'P1', [name]))),
}]);

add(badge({
  audience: 'creator',
  slug: 'curation-collector-ex',
  name: 'Curation Collector EX',
  secret: true,
  reducer: 'coverage',
  params: { expression: 'result((mine.some(level => level.ownerIsCharter == true) || mine.some(level => level.ownerIsVfxer == true)) && (!mine.some(level => level.ownerIsCharter == true) || ["C1", "C2", "C3", "O1", "O2", "O3"].every(name => mine.some(level => level.curation.includes(name)))) && (!mine.some(level => level.ownerIsVfxer == true) || ["V1", "V2", "V3"].every(name => mine.some(level => level.curation.includes(name)))) && ["H1", "H2", "Epic"].every(name => mine.some(level => level.curation.includes(name))) ? 1 : 0, 0, 0, 1)' },
}), {
  tier: 1,
  build: () => creator(['C1', 'C2', 'C3', 'O1', 'O2', 'O3', 'H1', 'H2', 'Epic'].map((name, index) => credited(index + 1, 'P1', [name]))),
}, [{
  tier: 0,
  build: () => creator(['C1', 'C2', 'C3', 'O1', 'O2', 'O3', 'H1', 'H2'].map((name, index) => credited(index + 1, 'P1', [name]))),
}]);

add(badge({
  audience: 'creator',
  slug: 'ultimate-balance',
  name: 'The Ultimate Balance Test',
  secret: true,
  reducer: 'best',
  params: { expression: 'curve(max(mine.filter(level => level.ownerIsCharter == true && level.curation.includes("C3")).map(level => level.charterCount)), 2, 1)' },
}), {
  tier: 1,
  credit: 2,
  build: () => creator([chart(1, 'U1', { curationNames: ['C3'], charterIds: [CREATOR, 4] })]),
}, [
  { tier: 0, build: () => creator([chart(1, 'U1', { curationNames: ['C3'], charterIds: [CREATOR] })]) },
  { tier: 0, build: () => creator([chart(1, 'U1', { curationNames: ['C2'], charterIds: [CREATOR, 4, 5] })]) },
]);

add(badge({
  audience: 'creator',
  slug: 'all-on-my-own',
  name: 'All on My Own :)',
  secret: true,
  reducer: 'coverage',
  params: { expression: 'curve(count(["C1", "C2", "C3"].filter(name => mine.some(level => level.curation.includes(name) && level.curation.includes("V3") && level.charterCount == 1 && level.vfxerCount == 1))), 1, 1)' },
}), {
  tier: 3,
  credit: 3,
  build: () => creator(['C1', 'C2', 'C3'].map((name, index) => chart(index + 1, 'G1', {
    curationNames: [name, 'V3'],
    charterIds: [CREATOR],
    vfxerIds: [CREATOR],
  }))),
}, [{
  tier: 1,
  build: () => creator([chart(1, 'G1', { curationNames: ['C1', 'V3'], charterIds: [CREATOR], vfxerIds: [CREATOR] })]),
}]);

add(badge({
  audience: 'creator',
  slug: 'master-of-less',
  name: 'The Master of Less',
  secret: true,
  reducer: 'coverage',
  params: { expression: 'curve(count(["P", "G"].filter(name => mine.some(level => level.curation.includes("C3") && level.family == name))), 1, 1)' },
}), {
  tier: 2,
  build: () => creator([
    credited(1, 'P3', ['C3']),
    credited(2, 'G2', ['C3']),
  ]),
}, [{ tier: 1, build: () => creator([credited(1, 'P3', ['C3'])]) }]);

add(badge({
  audience: 'creator',
  slug: 'tier-collector',
  name: 'Tier Collector',
  secret: true,
  reducer: 'coverage',
  params: { expression: 'curve((["C1", "V1", "H1", "Epic"].every(name => mine.some(level => level.curation.includes(name))) ? 1 : 0) + (["C1", "V1", "H1", "Epic"].every(name => mine.some(level => level.curation.includes(name))) && ["O2", "V2", "H2", "Epic"].every(name => mine.some(level => level.curation.includes(name))) ? 1 : 0), 1, 1)' },
}), {
  tier: 1,
  build: () => creator([chart(1, 'G1', { curationNames: ['C1', 'V1', 'H1', 'Epic'], charterIds: [CREATOR] })]),
}, [{
  tier: 2,
  build: () => creator([
    chart(1, 'G1', { curationNames: ['C1', 'V1', 'H1', 'Epic'], charterIds: [CREATOR] }),
    chart(2, 'P1', { curationNames: ['O2'], charterIds: [CREATOR] }),
    chart(3, 'P1', { curationNames: ['V2'], charterIds: [CREATOR] }),
    chart(4, 'P1', { curationNames: ['H2'], charterIds: [CREATOR] }),
  ]),
}]);

for (const [slug, name, filter] of [
  ['charter-p', 'P Charter', 'level.family == "P"'],
  ['charter-g', 'G Charter', 'level.family == "G"'],
  ['charter-u', 'U Charter', 'level.family == "U"'],
  ['charter-q', 'Q Charter', '(level.family == "GQ" || level.family == "UQ" || level.family == "QQ")'],
] as const) {
  const sample = slug === 'charter-q' ? 'GQ0' : slug === 'charter-g' ? 'G1' : slug === 'charter-u' ? 'U1' : 'P1';
  add(badge({
    audience: 'creator',
    slug,
    name,
    params: { expression: curveOf(`count(mine.filter(level => level.ownerIsCharter == true && ${filter}))`, 1, 2) },
  }), { tier: 1, build: () => creator([chart(1, sample, { charterIds: [CREATOR] })]) }, slug === 'charter-p' ? [
    { tier: 2, build: () => creator([1, 2, 3].map((id) => chart(id, 'P2', { charterIds: [CREATOR] }))) },
    { tier: 0, build: () => creator([chart(1, 'G1', { charterIds: [CREATOR] })]) },
  ] : []);
}

add(badge({
  audience: 'creator',
  slug: 'vfx-creator',
  name: 'VFX Creator',
  params: { expression: curveOf('count(mine.filter(level => level.ownerIsVfxer == true))', 1, 2) },
}), { tier: 1, build: () => creator([chart(1, 'P1', { vfxerIds: [CREATOR] })]) }, [
  { tier: 0, build: () => creator([chart(1, 'P1', { charterIds: [CREATOR] })]) },
]);

add(badge({
  audience: 'creator',
  slug: 'popular',
  name: 'Popular!',
  params: { expression: curveOf('max(mine.map(level => level.clears))', 1, 2) },
}), { tier: 1, build: () => creator([chart(1, 'G1', { clears: 1, charterIds: [CREATOR] })]) }, [
  { tier: 2, credit: 3, build: () => creator([chart(1, 'G1', { clears: 3, charterIds: [CREATOR] })]) },
]);

const endNames = REQUESTED_SETS.find((set) => set.name === 'end-to-end')?.values ?? [];
const endExNames = REQUESTED_SETS.find((set) => set.name === 'end-to-end-ex')?.values ?? [];

function charted(names: string[]): OwnerInput {
  return creator(names.map((name, index) => chart(index + 1, name, { charterIds: [CREATOR] })));
}

add(badge({
  audience: 'creator',
  slug: 'end-to-end',
  name: 'End to End',
  reducer: 'coverage',
  grant: 'resetOnGrowth',
  params: { expression: 'result(complete("end-to-end"), 0, 0, 1)' },
}), { tier: 1, build: () => charted(endNames) }, [
  { tier: 0, build: () => charted(endNames.slice(0, -1)) },
]);

add(badge({
  audience: 'creator',
  slug: 'end-to-end-ex',
  name: 'End to End EX',
  secret: true,
  reducer: 'coverage',
  grant: 'resetOnGrowth',
  params: { expression: 'result(complete("end-to-end-ex"), 0, 0, 1)' },
}), { tier: 1, build: () => charted(endExNames) });

add(badge({
  audience: 'creator',
  slug: 'number-one-fan',
  name: '#1 Fan',
  secret: true,
  params: { expression: curveOf('maxGroup(mine.filter(level => level.ownerIsCharter == true), "artistIds", "songId")', 20, 20) },
}), {
  tier: 1,
  build: () => creator(Array.from({ length: 20 }, (_, index) => chart(index + 1, 'P1', {
    songId: index + 1,
    artistIds: [42],
    charterIds: [CREATOR],
  }))),
}, [{
  tier: 0,
  build: () => creator(Array.from({ length: 19 }, (_, index) => chart(index + 1, 'P1', {
    songId: index + 1,
    artistIds: [42],
    charterIds: [CREATOR],
  }))),
}]);

export const requestedDefinitions = definitions;
export const requestedChecks = checks;
export const requestedDocument = {
  sets: REQUESTED_SETS,
  definitions,
};
