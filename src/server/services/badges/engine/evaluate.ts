import { formatAccuracyRatio } from './accuracyText.js';
import { formulaMatches, type FormulaContext } from './formula.js';
import { barForCredit, shownRequirement, tierForCredit } from './curve.js';
import {
  cachedOwnerDifficultyCounts,
  catalogDifficultyCoverage,
  frozenDifficultyCount,
  identitiesFromPasses,
  lookupDifficultyCount,
  ownerDifficultyCounts,
  type OwnerDifficultyCounts,
} from './difficultyCoverage.js';
import { difficultyFamily, difficultyNumber, identityKey, type IdentityMode, type LinkInfo } from './identity.js';
import {
  hasGamma,
  isAsymmetry,
  isPpMinusOne,
  isSymmetry,
  isTechnicallyPure,
  judgementTotal,
  perfectCount,
  type JudgementBuckets,
} from './judgement.js';
import type { BadgeDraft, BadgeParams, PatternMatch, SequenceParams } from './params.js';
import { evalValueExpr, fn, isFn, parseValueExpr, row, valueAsNumber, valueExprNames, type Value } from './valueExpr.js';
import {
  collectPlanSlotKeys,
  computeRollups,
  planValueExpr,
  type PlanNode,
  type RollupSlots,
} from './planExpr.js';
import { chaseProgress } from './chase.js';
import { BadgeJobCancelled, throwIfBadgeCancelled } from '../jobs/cancelSignal.js';

export type PassFact = {
  id: number;
  playerId: number;
  levelId: number;
  speed: number | null;
  keyCount: number | null;
  vidUploadTime: string | null;
  uploadTimeKnown: boolean;
  createdAt: string;
  accuracy: number | null;
  scoreV2: number | null;
  isWorldsFirst: boolean;
  isWorldsFirstPP: boolean;
  isXPerfectMode: boolean;
  ancient: boolean;
  judgements: JudgementBuckets;
  difficultyAtName: string;
  difficultyNowName: string;
  difficultySource: 'history' | 'snapshot' | 'current';
  durationMs: number | null;
};

export type ChartFact = {
  id: number;
  diffName: string;
  songId: number | null;
  song?: string | null;
  artistIds: number[];
  durationMs: number | null;
  curationNames: string[];
  charterIds: number[];
  vfxerIds: number[];
  clears: number;
  isReference: boolean;
  curationCounts: boolean;
};

export type WorldPass = {
  passId: number;
  playerId: number;
  levelId: number;
  vidUploadTime: string | null;
  uploadTimeKnown: boolean;
  accuracy: number | null;
  scoreV2: number | null;
  speed: number | null;
  isWorldsFirst: boolean;
  ancient: boolean;
};

export type BadgeSetValues = { kind: 'difficulty' | 'chart'; values: string[] | number[] };

export type OwnerInput = {
  ownerId: number;
  userId: string | null;
  passes: PassFact[];
  charts: ChartFact[];
  links: Record<number, LinkInfo>;
  sets: Record<string, BadgeSetValues>;
  packLevels: Record<number, number[]>;
  reviews: { definitionId: number; passId: number; status: 'pending' | 'approved' | 'rejected' }[];
  ratings: { levelId: number; createdAt: string }[];
  world: WorldPass[];
  frozenIds: number[] | null;
  since: string | null;
  difficultyCounts?: OwnerDifficultyCounts;
  rollups?: RollupSlots;
};

export type EvalResult = {
  tier: number;
  credit: number;
  barFrom: number;
  barTo: number;
  barValue: number;
  provingPassIds: number[];
  earnedAt: string | null;
  snapshotIds: number[] | null;
  reviewPassIds: number[];
  skipPlaceholder: number;
  skipUnknownTime: number;
  skipMissingDifficulty: number;
};

function emptyResult(): EvalResult {
  return {
    tier: 0,
    credit: 0,
    barFrom: 0,
    barTo: 1,
    barValue: 0,
    provingPassIds: [],
    earnedAt: null,
    snapshotIds: null,
    reviewPassIds: [],
    skipPlaceholder: 0,
    skipUnknownTime: 0,
    skipMissingDifficulty: 0,
  };
}

function chartOf(input: OwnerInput, levelId: number): ChartFact | undefined {
  return indexCharts(input.charts, input.links).byId.get(levelId);
}

function linkOf(input: OwnerInput, levelId: number): LinkInfo | null {
  return input.links[levelId] ?? null;
}

function keyFor(def: BadgeDraft, input: OwnerInput, levelId: number): string {
  return identityKey(def.identity, levelId, linkOf(input, levelId));
}

function diffName(pass: PassFact, useAt: boolean | undefined): string {
  return useAt ? pass.difficultyAtName : pass.difficultyNowName;
}

function inForwardWindow(def: BadgeDraft, input: OwnerInput, pass: PassFact): boolean {
  if (def.backfill !== 'forward' || !input.since) return true;
  return Date.parse(pass.createdAt) >= Date.parse(input.since);
}

function readsSheet(params: BadgeParams): boolean {
  return Boolean(
    params.purePerfect ||
    params.ppMinusOne ||
    params.symmetry ||
    params.technicallyPure ||
    params.noPerfects ||
    params.asymmetry ||
    params.gamma != null ||
    params.bucketEquals ||
    params.judgementPattern ||
    params.accuracyIncludes ||
    params.minAccuracy != null ||
    params.maxAccuracy != null ||
    params.exactAccuracy != null ||
    params.belowAccuracy != null ||
    params.minMisses != null ||
    params.noMisses ||
    params.scoreEndsWith ||
    params.sharedAccuracy ||
    params.perStep,
  );
}

function noteSkips(result: EvalResult, pass: PassFact, usesTime: boolean, usesDifficulty: boolean) {
  if (pass.ancient && usesTime === false) {
    /* placeholder skips are counted by the caller when a sheet is read */
  }
  if (usesTime && !pass.uploadTimeKnown) result.skipUnknownTime += 1;
  if (usesDifficulty && pass.difficultySource === 'current') result.skipMissingDifficulty += 1;
}

function passFormulaContext(pass: PassFact, chart: ChartFact | undefined): FormulaContext {
  const sheet = pass.judgements;
  const pure = pass.accuracy != null && pass.accuracy >= 1 - 1e-9;
  const when = pass.uploadTimeKnown && pass.vidUploadTime ? new Date(pass.vidUploadTime) : null;
  return {
    speed: pass.speed,
    accuracy: pass.accuracy,
    accuracyText: formatAccuracyRatio(pass.accuracy, false),
    score: pass.scoreV2,
    scoreText: pass.scoreV2 == null ? '' : Number(pass.scoreV2).toFixed(3),
    keyCount: pass.keyCount,
    misses: sheet.earlyDouble,
    perfects: perfectCount(sheet, pass.isXPerfectMode),
    perfect: sheet.perfect,
    perfectMinus: sheet.perfectMinus,
    perfectPlus: sheet.perfectPlus,
    earlies: sheet.earlySingle,
    lates: sheet.lateSingle,
    ePerfect: sheet.ePerfect,
    lPerfect: sheet.lPerfect,
    family: difficultyFamily(pass.difficultyNowName),
    familyAt: difficultyFamily(pass.difficultyAtName),
    difficulty: pass.difficultyNowName,
    difficultyAt: pass.difficultyAtName,
    levelId: pass.levelId,
    songId: chart?.songId ?? null,
    song: chart?.song ?? '',
    durationMs: pass.durationMs ?? chart?.durationMs ?? null,
    worldsFirst: Boolean(pass.isWorldsFirst && Number(pass.speed) === 1),
    worldsFirstPP: pass.isWorldsFirstPP,
    purePerfect: pure,
    ppMinusOne: isPpMinusOne(sheet, pass.isXPerfectMode),
    noMisses: sheet.earlyDouble === 0 && judgementTotal(sheet) > 0,
    symmetry: isSymmetry(sheet, pure),
    technicallyPure: isTechnicallyPure(sheet),
    noPerfects: perfectCount(sheet, pass.isXPerfectMode) === 0 && judgementTotal(sheet) > 0,
    asymmetry: isAsymmetry(sheet, pass.isXPerfectMode),
    ancient: pass.ancient,
    xPerfect: pass.isXPerfectMode,
    month: when ? when.getUTCMonth() + 1 : null,
    day: when ? when.getUTCDate() : null,
    clears: chart?.clears ?? 0,
    reference: chart?.isReference ?? false,
    charterCount: chart?.charterIds.length ?? 0,
    vfxerCount: chart?.vfxerIds.length ?? 0,
    curation: chart?.curationNames ?? [],
  };
}

function chartFormulaContext(chart: ChartFact): FormulaContext {
  return {
    levelId: chart.id,
    difficulty: chart.diffName,
    family: difficultyFamily(chart.diffName),
    songId: chart.songId,
    song: chart.song ?? '',
    durationMs: chart.durationMs,
    clears: chart.clears,
    reference: chart.isReference,
    charterCount: chart.charterIds.length,
    vfxerCount: chart.vfxerIds.length,
    curation: chart.curationNames,
  };
}

function formulaOk(expression: string | undefined, ctx: FormulaContext): boolean {
  return formulaMatches(expression, ctx);
}

function passMatchesPattern(pass: PassFact, chart: ChartFact | undefined, pattern: PatternMatch): boolean {
  if (pattern.expression && !formulaOk(pattern.expression, passFormulaContext(pass, chart))) return false;
  if (pattern.levelIds && !pattern.levelIds.includes(pass.levelId)) return false;
  if (pattern.families && !pattern.families.map((item) => item.toUpperCase()).includes(difficultyFamily(pass.difficultyNowName))) {
    return false;
  }
  if (pattern.minSpeed != null && !(Number(pass.speed) >= pattern.minSpeed)) return false;
  if (pattern.minDurationMs != null && !(Number(pass.durationMs ?? chart?.durationMs) >= pattern.minDurationMs)) return false;
  if (pattern.month != null || pattern.day != null) {
    if (!pass.uploadTimeKnown || !pass.vidUploadTime) return false;
    const date = new Date(pass.vidUploadTime);
    if (pattern.month != null && date.getUTCMonth() + 1 !== pattern.month) return false;
    if (pattern.day != null && date.getUTCDate() !== pattern.day) return false;
  }
  const sheet = pass.judgements;
  const pure = pass.accuracy != null && pass.accuracy >= 1 - 1e-9;
  if (pattern.purePerfect && !pure) return false;
  if (pattern.ppMinusOne && !isPpMinusOne(sheet, pass.isXPerfectMode)) return false;
  if (pattern.noMisses && sheet.earlyDouble !== 0) return false;
  if (pattern.minMisses != null && !(sheet.earlyDouble > pattern.minMisses)) return false;
  if (pattern.symmetry && !isSymmetry(sheet, pure)) return false;
  if (pattern.technicallyPure && !isTechnicallyPure(sheet)) return false;
  if (pattern.noPerfects && (perfectCount(sheet, pass.isXPerfectMode) !== 0 || judgementTotal(sheet) <= 0)) return false;
  if (pattern.asymmetry && !isAsymmetry(sheet, pass.isXPerfectMode)) return false;
  if (pattern.gamma != null && !hasGamma(sheet, pattern.gamma)) return false;
  if (pattern.bucketEquals && sheet[pattern.bucketEquals.bucket] !== pattern.bucketEquals.count) return false;
  if (pattern.judgementPattern) {
    const line = [
      sheet.earlyDouble, sheet.earlySingle, sheet.ePerfect, sheet.perfect,
      sheet.lPerfect, sheet.lateSingle, sheet.lateDouble,
    ];
    if (pattern.judgementPattern.some((value, index) => value !== line[index])) return false;
    if (sheet.perfectMinus !== 0 || sheet.perfectPlus !== 0) return false;
  }
  if (pattern.minAccuracy != null && !(Number(pass.accuracy) >= pattern.minAccuracy)) return false;
  if (pattern.maxAccuracy != null && !(Number(pass.accuracy) <= pattern.maxAccuracy)) return false;
  if (pattern.belowAccuracy != null && !(Number(pass.accuracy) < pattern.belowAccuracy)) return false;
  if (pattern.exactAccuracy != null && Math.abs(Number(pass.accuracy) - pattern.exactAccuracy) > 1e-6) return false;
  if (pattern.accuracyIncludes) {
    const rendered = formatAccuracyRatio(pass.accuracy);
    if (!rendered.toLowerCase().includes(pattern.accuracyIncludes.toLowerCase())) return false;
  }
  if (pattern.scoreEndsWith) {
    const decimals = pattern.scoreDecimals ?? 3;
    const rendered = Number(pass.scoreV2 ?? NaN).toFixed(decimals);
    if (!rendered.endsWith(pattern.scoreEndsWith)) return false;
  }
  return true;
}

function ignoredAccuracy(pass: { accuracy: number | null; ancient: boolean }): boolean {
  if (pass.ancient || pass.accuracy == null) return true;
  if (Math.abs(pass.accuracy - 1) < 1e-9) return true;
  if (Math.abs(pass.accuracy - 0.95) < 1e-9) return true;
  const rendered = formatAccuracyRatio(pass.accuracy);
  return rendered === '100%' || rendered.startsWith('95.00') || rendered === '95%';
}

function applyCurve(def: BadgeDraft, credit: number, proving: PassFact | undefined, base: EvalResult): EvalResult {
  const tier = tierForCredit(def.curve, credit);
  const bar = barForCredit(def.curve, credit, tier);
  return {
    ...base,
    tier,
    credit,
    barFrom: bar.from,
    barTo: bar.to,
    barValue: bar.value,
    provingPassIds: proving ? [proving.id] : base.provingPassIds,
    earnedAt: tier > 0 && proving?.uploadTimeKnown ? proving.vidUploadTime : null,
  };
}

function eligiblePasses(def: BadgeDraft, input: OwnerInput, sheet: boolean): PassFact[] {
  return input.passes.filter((pass) => {
    throwIfBadgeCancelled();
    return inForwardWindow(def, input, pass) && !(sheet && pass.ancient);
  });
}

function thresholdPassOk(def: BadgeDraft, input: OwnerInput, pass: PassFact): boolean {
  const params = def.params;
  if (def.grant === 'manualLock') {
    const approved = input.reviews.some((review) => (
      review.definitionId === def.id && review.passId === pass.id && review.status === 'approved'
    ));
    if (!approved) return false;
  }
  const chart = chartOf(input, pass.levelId);
  const name = diffName(pass, params.useDifficultyAt);
  if (params.minSpeed != null && !(Number(pass.speed) >= params.minSpeed)) return false;
  if (params.speedEquals != null && Number(pass.speed) !== params.speedEquals) return false;
  if (params.worldsFirst && !(pass.isWorldsFirst && Number(pass.speed) === 1)) return false;
  if (params.worldsFirstPP && !pass.isWorldsFirstPP) return false;
  if (params.purePerfect && !(pass.accuracy != null && pass.accuracy >= 1 - 1e-9)) return false;
  if (params.families && !params.families.map((item) => item.toUpperCase()).includes(difficultyFamily(name))) return false;
  if (params.difficultyNames && !params.difficultyNames.includes(name)) return false;
  if (params.difficultySet) {
    const set = input.sets[params.difficultySet];
    if (!set || set.kind !== 'difficulty' || !(set.values as string[]).includes(name)) return false;
  }
  if (params.maxKeyCount != null && !(pass.keyCount != null && pass.keyCount <= params.maxKeyCount)) return false;
  if (params.minKeyCount != null && !(pass.keyCount != null && pass.keyCount >= params.minKeyCount)) return false;
  if (params.minDurationMs != null && !(Number(pass.durationMs ?? chart?.durationMs) >= params.minDurationMs)) return false;
  if (params.expression && !formulaOk(params.expression, passFormulaContext(pass, chart))) return false;
  if (params.requireNoPriorClear) {
    const key = keyFor(def, input, pass.levelId);
    const when = pass.uploadTimeKnown && pass.vidUploadTime ? Date.parse(pass.vidUploadTime) : NaN;
    const prior = input.passes.some((other) => {
      if (other.id === pass.id || !other.uploadTimeKnown || !other.vidUploadTime) return false;
      if (keyFor(def, input, other.levelId) !== key) return false;
      return Number.isFinite(when) && Date.parse(other.vidUploadTime) < when;
    });
    if (prior) return false;
  }
  return true;
}

function creatorCharts(def: BadgeDraft, input: OwnerInput): ChartFact[] {
  const role = def.params.role ?? 'either';
  return input.charts.filter((chart) => {
    if (!chart.curationCounts && def.params.curationTypes) return false;
    const charter = chart.charterIds.includes(input.ownerId);
    const vfxer = chart.vfxerIds.includes(input.ownerId);
    if (role === 'charter' && !charter) return false;
    if (role === 'vfxer' && !vfxer) return false;
    if (role === 'either' && !charter && !vfxer) return false;
    if (def.params.sole) {
      if (role !== 'vfxer' && chart.charterIds.length !== 1) return false;
      if (role !== 'charter' && chart.vfxerIds.length !== 1) return false;
    }
    if (def.params.curationTypes && !def.params.curationTypes.some((name) => chart.curationNames.includes(name))) return false;
    if (def.params.families && !def.params.families.map((item) => item.toUpperCase()).includes(difficultyFamily(chart.diffName))) return false;
    if (def.params.difficultyNames && !def.params.difficultyNames.includes(chart.diffName)) return false;
    if (def.params.expression && !formulaOk(def.params.expression, chartFormulaContext(chart))) return false;
    return true;
  });
}

function chartWeight(def: BadgeDraft, chart: ChartFact): number {
  const role = def.params.role ?? 'either';
  const group = role === 'vfxer' ? chart.vfxerIds : role === 'charter' ? chart.charterIds : chart.charterIds.concat(chart.vfxerIds);
  return group.length <= 1 ? 1 : def.weight;
}

function isoWeek(iso: string): string {
  const date = new Date(iso);
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-${week}`;
}

function evaluateThreshold(def: BadgeDraft, input: OwnerInput): EvalResult {
  const result = emptyResult();
  const aggregate = def.params.aggregate ?? 'countDistinct';
  if (aggregate === 'ratingWeek') {
    const byWeek = new Map<string, Set<number>>();
    for (const rating of input.ratings) {
      const key = isoWeek(rating.createdAt);
      const set = byWeek.get(key) ?? new Set<number>();
      set.add(rating.levelId);
      byWeek.set(key, set);
    }
    let best = 0;
    for (const set of byWeek.values()) best = Math.max(best, set.size);
    return applyCurve(def, best, undefined, result);
  }
  if (def.audience === 'creator' || aggregate === 'maxChartClears' || aggregate === 'maxSongsPerArtist') {
    const charts = creatorCharts(def, input);
    if (aggregate === 'maxChartClears') {
      const best = charts.reduce((max, chart) => Math.max(max, chart.clears), 0);
      return applyCurve(def, best, undefined, result);
    }
    if (aggregate === 'maxSongsPerArtist') {
      const songs = new Map<number, Set<number>>();
      for (const chart of charts) {
        if (chart.songId == null) continue;
        for (const artistId of chart.artistIds) {
          const set = songs.get(artistId) ?? new Set<number>();
          set.add(chart.songId);
          songs.set(artistId, set);
        }
      }
      let best = 0;
      for (const set of songs.values()) best = Math.max(best, set.size);
      return applyCurve(def, best, undefined, result);
    }
    const credit = charts.reduce((sum, chart) => sum + chartWeight(def, chart), 0);
    return applyCurve(def, credit, undefined, result);
  }

  const sheet = Boolean(def.params.purePerfect);
  const passes = eligiblePasses(def, input, sheet).filter((pass) => thresholdPassOk(def, input, pass));
  for (const pass of input.passes) {
    throwIfBadgeCancelled();
    if (sheet && pass.ancient) result.skipPlaceholder += 1;
    if (def.params.useDifficultyAt) noteSkips(result, pass, false, true);
  }
  if (aggregate === 'maxPerSong') {
    const songs = new Map<number, Set<string>>();
    for (const pass of passes) {
      const songId = chartOf(input, pass.levelId)?.songId;
      if (songId == null) continue;
      const set = songs.get(songId) ?? new Set<string>();
      set.add(keyFor(def, input, pass.levelId));
      songs.set(songId, set);
    }
    let best = 0;
    for (const set of songs.values()) best = Math.max(best, set.size);
    return applyCurve(def, best, passes[0], result);
  }
  if (aggregate === 'maxPerIdentity') {
    const counts = new Map<string, number>();
    for (const pass of passes) {
      const key = keyFor(def, input, pass.levelId);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let best = 0;
    let proving: PassFact | undefined;
    for (const pass of passes) {
      const count = counts.get(keyFor(def, input, pass.levelId)) ?? 0;
      if (count > best) {
        best = count;
        proving = pass;
      }
    }
    return applyCurve(def, best, proving, result);
  }
  if (aggregate === 'count') return applyCurve(def, passes.length, passes[0], result);
  const seen = new Set<string>();
  const unique: PassFact[] = [];
  for (const pass of passes) {
    const key = keyFor(def, input, pass.levelId);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(pass);
  }
  return applyCurve(def, unique.length, unique[0], result);
}

function binsFor(def: BadgeDraft, input: OwnerInput): string[] {
  const params = def.params;
  if (params.source === 'references') {
    return input.charts.filter((chart) => chart.isReference).map((chart) => String(chart.id));
  }
  if (params.source === 'curation') {
    const type = params.curationType ?? '';
    return input.charts
      .filter((chart) => chart.curationCounts && chart.curationNames.includes(type))
      .map((chart) => String(chart.id));
  }
  if (params.source === 'curationTypes') {
    if (params.roleScoped) {
      const role = params.role ?? 'either';
      const mine = input.charts.filter((chart) => (
        chart.charterIds.includes(input.ownerId) || chart.vfxerIds.includes(input.ownerId)
      ));
      const charterSide = role === 'charter' || (role === 'either' && mine.some((chart) => chart.charterIds.includes(input.ownerId)));
      const vfxSide = role === 'vfxer' || (role === 'either' && mine.some((chart) => chart.vfxerIds.includes(input.ownerId)));
      const names: string[] = [];
      if (charterSide) names.push('C1', 'C2', 'C3');
      if (charterSide && params.roleScope === 'ex') names.push('O1', 'O2', 'O3');
      if (vfxSide) names.push('V1', 'V2', 'V3');
      if ((charterSide || vfxSide) && params.roleScope === 'ex') names.push('H1', 'H2', 'Epic');
      if (!names.length) {
        if (role !== 'vfxer') names.push('C1', 'C2', 'C3');
        if (role !== 'charter') names.push('V1', 'V2', 'V3');
      }
      return names;
    }
    return params.types ?? [];
  }
  if (params.source === 'expressions') return (params.expressions ?? []).map((_, index) => String(index));
  if (params.source === 'groups') return (params.groups ?? []).map((_, index) => String(index));
  const set = params.set ? input.sets[params.set] : undefined;
  if (!set) return [];
  return set.values.map((value) => String(value));
}

function filledBins(def: BadgeDraft, input: OwnerInput, bins: string[]): boolean[] {
  const params = def.params;
  if (params.source === 'curationTypes') {
    const charts = creatorCharts(def, input);
    return bins.map((bin) => charts.some((chart) => chart.curationNames.includes(bin)));
  }
  if (params.source === 'expressions') {
    const expressions = params.expressions ?? [];
    if (def.audience === 'creator') {
      const charts = creatorCharts(def, input);
      return expressions.map((expression) => charts.some((chart) => formulaMatches(expression, chartFormulaContext(chart))));
    }
    const passes = eligiblePasses(def, input, false);
    return expressions.map((expression) => passes.some((pass) => formulaMatches(expression, passFormulaContext(pass, chartOf(input, pass.levelId)))));
  }
  if (params.source === 'groups') {
    const charts = creatorCharts(def, input);
    return (params.groups ?? []).map((group) => group.every((expression) => (
      charts.some((chart) => formulaMatches(expression, chartFormulaContext(chart)))
    )));
  }
  if (params.source === 'set' && input.sets[params.set ?? '']?.kind === 'difficulty') {
    if (def.audience === 'creator') {
      const charts = creatorCharts(def, input);
      return bins.map((bin) => charts.some((chart) => chart.diffName === bin));
    }
    const names = new Set(eligiblePasses(def, input, false).map((pass) => diffName(pass, true)));
    return bins.map((bin) => names.has(bin));
  }
  const cleared = new Set(eligiblePasses(def, input, false).map((pass) => keyFor(def, input, pass.levelId)));
  return bins.map((bin) => cleared.has(keyFor(def, input, Number(bin))));
}

function evaluateCoverage(def: BadgeDraft, input: OwnerInput): EvalResult {
  const result = emptyResult();
  const bins = binsFor(def, input);
  const filled = filledBins(def, input, bins);
  let credit = 0;
  if (def.params.prefix || def.params.ordered) {
    for (const ok of filled) {
      if (!ok) break;
      credit += 1;
    }
  } else {
    credit = filled.filter(Boolean).length;
  }
  const curved = applyCurve(def, credit, undefined, result);
  curved.barFrom = 0;
  curved.barTo = Math.max(bins.length, 1);
  curved.barValue = credit;
  if (def.params.complete) {
    curved.tier = bins.length > 0 && credit === bins.length ? 1 : 0;
    if (curved.tier === 0) curved.earnedAt = null;
  }
  return curved;
}

function evaluatePercent(def: BadgeDraft, input: OwnerInput): EvalResult {
  const result = emptyResult();
  const params = def.params;
  const index = indexCharts(input.charts, input.links);
  const frozen = input.frozenIds ? new Set(input.frozenIds) : null;
  const family = params.family ? params.family.toUpperCase() : null;
  const named = params.difficultyName ? index.byDifficulty.get(params.difficultyName) ?? [] : input.charts;
  const pool = named.filter((chart) => {
    if (family && difficultyFamily(chart.diffName) !== family) return false;
    if (frozen && !frozen.has(chart.id)) return false;
    return true;
  });
  const denomIds = pool.map((chart) => chart.id);
  const denomSet = new Set(denomIds);
  const clearedLevels = new Set(
    eligiblePasses(def, input, false)
      .filter((pass) => denomSet.has(pass.levelId))
      .map((pass) => pass.levelId),
  );
  const groups = new Map<string, number[]>();
  for (const chart of pool) {
    const key = chartIdentity(index, def.identity, chart.id);
    const ids = groups.get(key) ?? [];
    ids.push(chart.id);
    groups.set(key, ids);
  }
  let numer = 0;
  for (const ids of groups.values()) {
    if (ids.some((id) => clearedLevels.has(id))) numer += 1;
  }
  const denom = groups.size;
  const cleared = clearedLevels;
  const fraction = params.fraction ?? 1;
  const met = denom >= (params.minCharts ?? 0) && denom > 0 && numer / denom + 1e-9 >= fraction;
  result.credit = numer;
  result.tier = met ? 1 : 0;
  result.barFrom = 0;
  result.barTo = denom;
  result.barValue = numer;
  result.snapshotIds = denomIds;
  result.provingPassIds = eligiblePasses(def, input, false)
    .filter((pass) => cleared.has(pass.levelId))
    .slice(0, 8)
    .map((pass) => pass.id);
  return result;
}

function evaluateRecord(def: BadgeDraft, input: OwnerInput): EvalResult {
  const result = emptyResult();
  const metric = def.params.metric ?? 'accuracy';
  const families = def.params.families?.map((item) => item.toUpperCase());
  const byLevel = new Map<number, WorldPass[]>();
  for (const pass of input.world) {
    throwIfBadgeCancelled();
    const list = byLevel.get(pass.levelId) ?? [];
    list.push(pass);
    byLevel.set(pass.levelId, list);
  }
  let charts = 0;
  let bestOthers = 0;
  const sheetMetric = metric === 'accuracy' || metric === 'score';
  for (const [levelId, passes] of byLevel) {
    const chart = chartOf(input, levelId);
    if (families && !families.includes(difficultyFamily(chart?.diffName))) continue;
    if (chart && def.params.expression && !formulaOk(def.params.expression, chartFormulaContext(chart))) continue;
    const usable = passes.filter((pass) => !(sheetMetric && pass.ancient));
    if (sheetMetric) result.skipPlaceholder += passes.filter((pass) => pass.ancient).length;
    const valueOf = (pass: WorldPass) => {
      if (metric === 'speed') return Number(pass.speed);
      if (metric === 'score') return Number(pass.scoreV2);
      return Number(pass.accuracy);
    };
    let best = -Infinity;
    for (const pass of usable) {
      const value = valueOf(pass);
      if (Number.isFinite(value) && value > best) best = value;
    }
    if (!Number.isFinite(best)) continue;
    const holders = new Set(usable.filter((pass) => valueOf(pass) === best).map((pass) => pass.playerId));
    if (!holders.has(input.ownerId)) continue;
    if (def.params.requireWorldsFirst && !usable.some((pass) => pass.playerId === input.ownerId && pass.isWorldsFirst)) continue;
    if (def.params.requireHighestScore) {
      const top = Math.max(...usable.map((pass) => Number(pass.scoreV2)).filter((value) => Number.isFinite(value)));
      const mine = usable.some((pass) => pass.playerId === input.ownerId && Number(pass.scoreV2) === top);
      if (!mine) continue;
    }
    if (def.params.requireHighestSpeed) {
      const top = Math.max(...usable.map((pass) => Number(pass.speed)).filter((value) => Number.isFinite(value)));
      const mine = usable.some((pass) => pass.playerId === input.ownerId && Number(pass.speed) === top);
      if (!mine) continue;
    }
    const others = new Set(usable.filter((pass) => pass.playerId !== input.ownerId).map((pass) => pass.playerId));
    charts += 1;
    bestOthers = Math.max(bestOthers, others.size);
  }
  const credit = def.params.creditFrom === 'otherClears' ? bestOthers : charts;
  return applyCurve(def, credit, undefined, result);
}

function evaluatePattern(def: BadgeDraft, input: OwnerInput, pattern: PatternMatch): EvalResult {
  const result = emptyResult();
  if (pattern.sharedAccuracy) {
    const groups = new Map<string, WorldPass[]>();
    for (const pass of input.world) {
    throwIfBadgeCancelled();
      if (ignoredAccuracy(pass)) {
        if (pass.ancient) result.skipPlaceholder += 1;
        continue;
      }
      const chart = chartOf(input, pass.levelId);
      const family = difficultyFamily(chart?.diffName);
      if (family !== 'G' && family !== 'U') continue;
      const rendered = formatAccuracyRatio(pass.accuracy);
      const list = groups.get(rendered) ?? [];
      list.push(pass);
      groups.set(rendered, list);
    }
    const mine = new Set<number>();
    for (const list of groups.values()) {
      const players = new Set(list.map((pass) => pass.playerId));
      const identities = new Set(list.map((pass) => keyFor(def, input, pass.levelId)));
      if (players.size < 2 || identities.size < 2) continue;
      for (const pass of list) {
        if (pass.playerId !== input.ownerId) continue;
        const shared = list.some((other) => other.playerId !== pass.playerId && keyFor(def, input, other.levelId) !== keyFor(def, input, pass.levelId));
        if (shared) mine.add(pass.levelId);
      }
    }
    return applyCurve(def, mine.size, undefined, result);
  }
  const matches: PassFact[] = [];
  for (const pass of input.passes) {
    throwIfBadgeCancelled();
    if (!inForwardWindow(def, input, pass)) continue;
    if (pass.ancient) {
      result.skipPlaceholder += 1;
      continue;
    }
    if ((pattern.month != null || pattern.day != null) && !pass.uploadTimeKnown) result.skipUnknownTime += 1;
    if (passMatchesPattern(pass, chartOf(input, pass.levelId), pattern)) matches.push(pass);
  }
  const curved = applyCurve(def, matches.length, matches[0], result);
  curved.provingPassIds = matches.slice(0, 8).map((pass) => pass.id);
  curved.reviewPassIds = matches.map((pass) => pass.id);
  return curved;
}

function blockRequired(def: BadgeDraft, input: OwnerInput, ids: number[], exclude: string[]): number[] {
  const excluded = new Set(exclude.map((name) => name.toLowerCase()));
  return ids.filter((id) => {
    const chart = chartOf(input, id);
    if (!chart) return false;
    return !excluded.has(chart.diffName.toLowerCase());
  });
}

function evaluateSequence(def: BadgeDraft, input: OwnerInput, sequence: SequenceParams): EvalResult {
  const result = emptyResult();
  const passes = eligiblePasses(def, input, Boolean(sequence.perStep))
    .filter((pass) => pass.uploadTimeKnown)
    .sort((a, b) => Date.parse(a.vidUploadTime || '') - Date.parse(b.vidUploadTime || '') || a.id - b.id);
  for (const pass of input.passes) {
    throwIfBadgeCancelled();
    if (!pass.uploadTimeKnown) result.skipUnknownTime += 1;
    if (sequence.perStep && pass.ancient) result.skipPlaceholder += 1;
  }
  if (sequence.order && sequence.order.length) {
    let cursor = 0;
    const proving: PassFact[] = [];
    for (let index = 0; index < sequence.order.length; index += 1) {
      const levelId = sequence.order[index];
      let found = -1;
      for (let passIndex = cursor; passIndex < passes.length; passIndex += 1) {
        const pass = passes[passIndex];
        if (pass.levelId !== levelId) continue;
        const step = sequence.perStep ?? (sequence.expression ? { expression: sequence.expression } : undefined);
        if (step && !passMatchesPattern(pass, chartOf(input, pass.levelId), step)) continue;
        if (sequence.consecutive && proving.length && passIndex !== cursor) break;
        found = passIndex;
        break;
      }
      if (found < 0) return { ...result, credit: index, barFrom: 0, barTo: sequence.order.length, barValue: index };
      proving.push(passes[found]);
      cursor = sequence.consecutive ? found + 1 : found + 1;
    }
    const curved = applyCurve(def, 1, proving[0], result);
    curved.provingPassIds = proving.map((pass) => pass.id);
    curved.reviewPassIds = proving.map((pass) => pass.id);
    return curved;
  }
  const exclude = sequence.excludeDifficultyNames ?? [];
  let blocks = sequence.blocks ?? [];
  if (sequence.rangeSize && sequence.rangeSize > 0) {
    const maxId = input.charts.reduce((max, chart) => Math.max(max, chart.id), 0);
    blocks = [];
    for (let start = 1; start <= maxId; start += sequence.rangeSize) {
      const ids: number[] = [];
      for (let id = start; id < start + sequence.rangeSize; id += 1) ids.push(id);
      blocks.push(ids);
    }
  }
  let completed = 0;
  for (const block of blocks) {
    const required = blockRequired(def, input, block, exclude);
    if (required.length === 0) {
      completed += 1;
      continue;
    }
    const have = required.filter((id) => input.passes.some((pass) => {
      if (pass.levelId !== id || !inForwardWindow(def, input, pass)) return false;
      const step = sequence.perStep ?? (sequence.expression ? { expression: sequence.expression } : undefined);
      return !step || passMatchesPattern(pass, chartOf(input, pass.levelId), step);
    })).length;
    if (have < required.length) {
      const curved = applyCurve(def, completed, undefined, result);
      curved.barFrom = 0;
      curved.barTo = required.length;
      curved.barValue = have;
      return curved;
    }
    completed += 1;
  }
  const curved = applyCurve(def, completed, undefined, result);
  curved.barFrom = 0;
  curved.barTo = Math.max(blocks.length, 1);
  curved.barValue = completed;
  return curved;
}

function evaluateGap(def: BadgeDraft, input: OwnerInput): EvalResult {
  const result = emptyResult();
  const byKey = new Map<string, PassFact[]>();
  for (const pass of eligiblePasses(def, input, false)) {
    if (!pass.uploadTimeKnown || !pass.vidUploadTime) {
      result.skipUnknownTime += 1;
      continue;
    }
    if (def.params.expression && !formulaOk(def.params.expression, passFormulaContext(pass, chartOf(input, pass.levelId)))) continue;
    const key = keyFor(def, input, pass.levelId);
    const list = byKey.get(key) ?? [];
    list.push(pass);
    byKey.set(key, list);
  }
  let best = 0;
  let proving: PassFact | undefined;
  const minDays = def.params.minDays ?? 0;
  for (const list of byKey.values()) {
    list.sort((a, b) => Date.parse(a.vidUploadTime || '') - Date.parse(b.vidUploadTime || ''));
    for (let index = 1; index < list.length; index += 1) {
      const days = (Date.parse(list[index].vidUploadTime || '') - Date.parse(list[index - 1].vidUploadTime || '')) / 86400000;
      if (days >= minDays && days > best) {
        best = days;
        proving = list[index];
      }
    }
  }
  return applyCurve(def, best, proving, result);
}

function evaluateNth(def: BadgeDraft, input: OwnerInput): EvalResult {
  const result = emptyResult();
  const n = def.params.n ?? 1;
  const byKey = new Map<string, WorldPass[]>();
  for (const pass of input.world) {
    throwIfBadgeCancelled();
    if (!pass.uploadTimeKnown || !pass.vidUploadTime) continue;
    const key = keyFor(def, input, pass.levelId);
    const list = byKey.get(key) ?? [];
    list.push(pass);
    byKey.set(key, list);
  }
  let credit = 0;
  for (const list of byKey.values()) {
    list.sort((a, b) => Date.parse(a.vidUploadTime || '') - Date.parse(b.vidUploadTime || '') || a.passId - b.passId);
    const seen: number[] = [];
    for (const pass of list) {
      if (!seen.includes(pass.playerId)) seen.push(pass.playerId);
    }
    if (seen[n - 1] === input.ownerId) credit += 1;
  }
  return applyCurve(def, credit, undefined, result);
}

function evaluateChase(def: BadgeDraft, input: OwnerInput): EvalResult {
  const result = emptyResult();
  const exclude = new Set((def.params.excludeDifficultyNames ?? []).map((name) => name.toLowerCase()));
  const eligible = input.charts
    .filter((chart) => !exclude.has(chart.diffName.toLowerCase()))
    .map((chart) => chart.id)
    .sort((a, b) => a - b);
  const cleared = new Set(eligiblePasses(def, input, false).map((pass) => pass.levelId));
  const uncleared = eligible.filter((id) => !cleared.has(id));
  const lowest = uncleared[0] ?? 0;
  const minimum = eligible[0];
  result.credit = lowest;
  result.tier = minimum != null && cleared.has(minimum) ? 1 : 0;
  result.barFrom = 0;
  result.barTo = lowest || 1;
  result.barValue = result.tier;
  return result;
}

function evaluateBest(def: BadgeDraft, input: OwnerInput): EvalResult {
  const result = emptyResult();
  const metric = def.params.metric ?? 'keyCount';
  const sheet = metric === 'perfectCount' || metric === 'misses' || metric === 'accuracy';
  const families = def.params.families?.map((item) => item.toUpperCase());
  let best: number | null = null;
  let proving: PassFact | undefined;
  const lower = def.curve.direction === 'down' || metric === 'keyCount' || metric === 'perfectCount' || metric === 'misses';
  if (def.audience === 'creator') {
    let chosen: number | null = null;
    for (const chart of creatorCharts(def, input)) {
      let value: number | null = null;
      if (metric === 'charterCount') value = chart.charterIds.length;
      else if (metric === 'difficultyNumber') value = difficultyNumber(chart.diffName);
      if (value == null || !Number.isFinite(value)) continue;
      if (chosen == null || (lower ? value < chosen : value > chosen)) chosen = value;
    }
    if (chosen == null) return result;
    return applyCurve(def, chosen, undefined, result);
  }
  for (const pass of eligiblePasses(def, input, sheet)) {
    if (sheet && pass.ancient) {
      result.skipPlaceholder += 1;
      continue;
    }
    const name = diffName(pass, def.params.useDifficultyAt);
    if (families && !families.includes(difficultyFamily(name))) continue;
    if (def.params.expression && !formulaOk(def.params.expression, passFormulaContext(pass, chartOf(input, pass.levelId)))) continue;
    if (def.params.useDifficultyAt && pass.difficultySource === 'current') result.skipMissingDifficulty += 1;
    let value: number | null = null;
    if (metric === 'keyCount') value = pass.keyCount;
    else if (metric === 'perfectCount') value = perfectCount(pass.judgements, pass.isXPerfectMode);
    else if (metric === 'misses') value = pass.judgements.earlyDouble;
    else if (metric === 'speed') value = pass.speed;
    else if (metric === 'accuracy') value = pass.accuracy;
    else if (metric === 'charterCount') value = chartOf(input, pass.levelId)?.charterIds.length ?? null;
    else value = difficultyNumber(name);
    if (value == null || !Number.isFinite(value)) continue;
    if (best == null || (lower ? value < best : value > best)) {
      best = value;
      proving = pass;
    }
  }
  if (best == null) return result;
  return applyCurve(def, best, proving, result);
}

export function packMembership(
  levelIds: readonly number[],
  identity: BadgeDraft['identity'],
  links: Record<number, LinkInfo>,
  clearedLevelIds: ReadonlySet<number>,
): { required: string[]; cleared: number } {
  const required: string[] = [];
  const seen = new Set<string>();
  for (const levelId of levelIds) {
    const key = identityKey(identity, levelId, links[levelId] ?? null);
    if (seen.has(key)) continue;
    seen.add(key);
    required.push(key);
  }
  let cleared = 0;
  for (const key of required) {
    const hit = levelIds.some((levelId) => {
      if (!clearedLevelIds.has(levelId)) return false;
      return identityKey(identity, levelId, links[levelId] ?? null) === key;
    });
    if (hit) cleared += 1;
  }
  return { required, cleared };
}

function evaluatePack(def: BadgeDraft, input: OwnerInput): EvalResult {
  const result = emptyResult();
  const packId = def.params.packId ?? 0;
  const ids = (input.packLevels[packId] ?? []).filter((id) => chartOf(input, id));
  const clearedIds = new Set(eligiblePasses(def, input, false).map((pass) => pass.levelId));
  const membership = packMembership(ids, def.identity, input.links, clearedIds);
  const total = membership.required.length;
  result.credit = membership.cleared;
  result.tier = total > 0 && membership.cleared >= total ? 1 : 0;
  result.barFrom = 0;
  result.barTo = total;
  result.barValue = membership.cleared;
  return result;
}

function shown(def: BadgeDraft, result: EvalResult): EvalResult {
  if (def.reducer === 'percentOf' || def.reducer === 'pack' || def.reducer === 'chase' || def.reducer === 'value') return result;
  const requirement = shownRequirement(def.curve, Math.max(result.tier, 1));
  if (def.curve.round === 'ceil' && result.barTo > 0) {
    return { ...result, barTo: Math.max(result.barTo, requirement) };
  }
  return result;
}

function rowNum(value: Value, name: string): number | null {
  const field = rowVal(value, name);
  return typeof field === 'number' && Number.isFinite(field) ? field : null;
}

function rowVal(value: Value, name: string): Value {
  if (value && typeof value === 'object' && !Array.isArray(value) && value.kind === 'row') {
    return value.fields[name] ?? null;
  }
  return null;
}

function rowsOf(value: Value): Value[] {
  return Array.isArray(value) ? value : [];
}

function clearRecord(def: BadgeDraft, input: OwnerInput, pass: PassFact): Value {
  const chart = chartOf(input, pass.levelId);
  const sheet = pass.judgements;
  const pure = pass.accuracy != null && pass.accuracy >= 1 - 1e-9;
  const when = pass.uploadTimeKnown && pass.vidUploadTime ? new Date(pass.vidUploadTime) : null;
  const judgement = pass.ancient
    ? {
      misses: null,
      perfects: null,
      earlies: null,
      lates: null,
      ePerfect: null,
      lPerfect: null,
      perfect: null,
      perfectMinus: null,
      perfectPlus: null,
      purePerfect: false,
      ppMinusOne: false,
      noMisses: false,
      symmetry: false,
      technicallyPure: false,
      noPerfects: false,
      asymmetry: false,
    }
    : {
      misses: sheet.earlyDouble,
      perfects: perfectCount(sheet, pass.isXPerfectMode),
      earlies: sheet.earlySingle,
      lates: sheet.lateSingle,
      ePerfect: sheet.ePerfect,
      lPerfect: sheet.lPerfect,
      perfect: sheet.perfect,
      perfectMinus: sheet.perfectMinus,
      perfectPlus: sheet.perfectPlus,
      purePerfect: pure,
      ppMinusOne: isPpMinusOne(sheet, pass.isXPerfectMode),
      noMisses: sheet.earlyDouble === 0 && judgementTotal(sheet) > 0,
      symmetry: isSymmetry(sheet, pure),
      technicallyPure: isTechnicallyPure(sheet),
      noPerfects: perfectCount(sheet, pass.isXPerfectMode) === 0 && judgementTotal(sheet) > 0,
      asymmetry: isAsymmetry(sheet, pass.isXPerfectMode),
    };
  return row({
    passId: pass.id,
    levelId: pass.levelId,
    identity: keyFor(def, input, pass.levelId),
    speed: pass.speed,
    accuracy: pass.ancient ? null : pass.accuracy,
    score: pass.ancient ? null : pass.scoreV2,
    keyCount: pass.keyCount,
    difficulty: pass.difficultyNowName,
    difficultyAt: pass.difficultyAtName,
    family: difficultyFamily(pass.difficultyNowName),
    familyAt: difficultyFamily(pass.difficultyAtName),
    songId: chart?.songId ?? null,
    song: chart?.song ?? '',
    durationMs: pass.durationMs ?? chart?.durationMs ?? null,
    worldsFirst: Boolean(pass.isWorldsFirst && Number(pass.speed) === 1),
    isWorldsFirst: Boolean(pass.isWorldsFirst),
    worldsFirstPP: pass.isWorldsFirstPP,
    ancient: pass.ancient,
    xPerfect: pass.isXPerfectMode,
    month: when ? when.getUTCMonth() + 1 : null,
    day: when ? when.getUTCDate() : null,
    uploadMs: when ? when.getTime() : null,
    charterCount: chart?.charterIds.length ?? 0,
    vfxerCount: chart?.vfxerIds.length ?? 0,
    reference: Boolean(chart?.isReference),
    ownerIsCharter: Boolean(chart?.charterIds.includes(input.ownerId)),
    ownerIsVfxer: Boolean(chart?.vfxerIds.includes(input.ownerId)),
    curation: chart?.curationNames ?? [],
    noPriorClear: false,
    scoreText: pass.ancient || pass.scoreV2 == null ? '' : Number(pass.scoreV2).toFixed(3),
    accuracyText: pass.ancient ? '' : formatAccuracyRatio(pass.accuracy, false),
    ...judgement,
  });
}

function levelRecord(def: BadgeDraft, input: OwnerInput, chart: ChartFact): Value {
  const players = rivalsFor(input.world, chart.id);
  const rivals = players ? players.size - (players.has(input.ownerId) ? 1 : 0) : 0;
  return row({
    levelId: chart.id,
    identity: keyFor(def, input, chart.id),
    difficulty: chart.diffName,
    family: difficultyFamily(chart.diffName),
    songId: chart.songId,
    song: chart.song ?? '',
    durationMs: chart.durationMs,
    clears: chart.clears,
    reference: chart.isReference,
    charterCount: chart.charterIds.length,
    vfxerCount: chart.vfxerIds.length,
    ownerIsCharter: chart.charterIds.includes(input.ownerId),
    ownerIsVfxer: chart.vfxerIds.includes(input.ownerId),
    curation: chart.curationCounts ? chart.curationNames : [],
    artistIds: chart.artistIds,
    rivals,
  });
}

type ChartIndex = {
  byId: Map<number, ChartFact>;
  byDifficulty: Map<string, ChartFact[]>;
  links: Record<number, LinkInfo>;
  identities: Map<IdentityMode, Map<number, string>>;
};

const chartIndexes = new WeakMap<ChartFact[], ChartIndex>();

const worldIndexes = new WeakMap<WorldPass[], {
  byLevel: Map<number, WorldPass[]>;
  rivals: Map<number, Set<number>>;
}>();

function indexCharts(charts: ChartFact[], links: Record<number, LinkInfo>): ChartIndex {
  const cached = chartIndexes.get(charts);
  if (cached && cached.links === links) return cached;
  const byId = new Map<number, ChartFact>();
  const byDifficulty = new Map<string, ChartFact[]>();
  for (const chart of charts) {
    throwIfBadgeCancelled();
    byId.set(chart.id, chart);
    const list = byDifficulty.get(chart.diffName);
    if (list) list.push(chart);
    else byDifficulty.set(chart.diffName, [chart]);
  }
  const built: ChartIndex = { byId, byDifficulty, links, identities: new Map() };
  chartIndexes.set(charts, built);
  return built;
}

function chartIdentity(index: ChartIndex, mode: IdentityMode, levelId: number): string {
  let map = index.identities.get(mode);
  if (!map) {
    map = new Map<number, string>();
    for (const id of index.byId.keys()) {
      throwIfBadgeCancelled();
      map.set(id, identityKey(mode, id, index.links[id] ?? null));
    }
    index.identities.set(mode, map);
  }
  return map.get(levelId) ?? identityKey(mode, levelId, index.links[levelId] ?? null);
}

function cacheableOwnerIdentities(def: BadgeDraft, input: OwnerInput): boolean {
  return !input.frozenIds
    && def.grant !== 'manualLock'
    && (def.backfill !== 'forward' || !input.since);
}

function ownerClearedIdentities(def: BadgeDraft, input: OwnerInput, passes?: PassFact[]): Set<string> {
  const table = catalogDifficultyCoverage(input.charts, input.links, def.identity);
  const source = cacheableOwnerIdentities(def, input) ? input.passes : (passes ?? scopedPasses(def, input));
  return identitiesFromPasses(table, input.links, source);
}

function indexWorld(world: WorldPass[]) {
  const cached = worldIndexes.get(world);
  if (cached) return cached;
  const byLevel = new Map<number, WorldPass[]>();
  const rivals = new Map<number, Set<number>>();
  for (const pass of world) {
    throwIfBadgeCancelled();
    const list = byLevel.get(pass.levelId);
    if (list) list.push(pass);
    else byLevel.set(pass.levelId, [pass]);
    if (pass.ancient) continue;
    const players = rivals.get(pass.levelId);
    if (players) players.add(pass.playerId);
    else rivals.set(pass.levelId, new Set([pass.playerId]));
  }
  const built = { byLevel, rivals };
  worldIndexes.set(world, built);
  return built;
}

function worldOnLevel(world: WorldPass[], levelId: number): WorldPass[] {
  return indexWorld(world).byLevel.get(levelId) ?? [];
}

function rivalsFor(world: WorldPass[], levelId: number): Set<number> | undefined {
  return indexWorld(world).rivals.get(levelId);
}

function markFirstClears(clears: Value[]): void {
  const groups = new Map<string, Value[]>();
  for (const clear of clears) {
    const key = String(rowVal(clear, 'identity') ?? '');
    const list = groups.get(key) ?? [];
    list.push(clear);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    const known = list
      .filter((clear) => rowNum(clear, 'uploadMs') != null)
      .sort((a, b) => (rowNum(a, 'uploadMs') ?? 0) - (rowNum(b, 'uploadMs') ?? 0));
    known.forEach((clear, index) => {
      if (clear && typeof clear === 'object' && !Array.isArray(clear) && clear.kind === 'row') {
        clear.fields.noPriorClear = index === 0;
      }
    });
  }
}

function orderedClears(clears: Value[]): Value[] {
  return clears
    .filter((clear) => rowNum(clear, 'uploadMs') != null)
    .sort((a, b) => (rowNum(a, 'uploadMs') ?? 0) - (rowNum(b, 'uploadMs') ?? 0) || (rowNum(a, 'passId') ?? 0) - (rowNum(b, 'passId') ?? 0));
}

function matchSequence(clears: Value[], ids: number[], consecutive: boolean, pred?: Value): number {
  const timed = orderedClears(clears);
  let cursor = 0;
  let done = 0;
  for (const levelId of ids) {
    let found = -1;
    for (let index = cursor; index < timed.length; index += 1) {
      if (rowNum(timed[index], 'levelId') !== levelId) continue;
      if (pred && typeof pred === 'object' && !Array.isArray(pred) && pred.kind === 'fn' && !truthyValue(pred.call([timed[index]]))) {
        continue;
      }
      if (consecutive && done > 0 && index !== cursor) return done;
      found = index;
      break;
    }
    if (found < 0) return done;
    done += 1;
    cursor = found + 1;
  }
  return done;
}

function truthyValue(value: Value): boolean {
  return value != null && value !== false && value !== 0 && value !== '';
}

function numberList(value: Value): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => Number(item)).filter((item) => Number.isInteger(item));
}

function scopedPasses(def: BadgeDraft, input: OwnerInput): PassFact[] {
  const approved = new Set(
    input.reviews
      .filter((review) => review.definitionId === def.id && review.status === 'approved')
      .map((review) => review.passId),
  );
  const frozen = input.frozenIds ? new Set(input.frozenIds) : null;
  return eligiblePasses(def, input, false).filter((pass) => (
    (def.grant !== 'manualLock' || approved.has(pass.id))
    && (!frozen || frozen.has(pass.levelId))
  ));
}

function valueScope(
  def: BadgeDraft,
  input: OwnerInput,
  names: Set<string>,
  captured?: Set<number>,
  matchedPasses?: Set<number>,
  difficultyMemo?: Map<string, Value>,
): Map<string, Value> {
  const needClears = names.has('clears') || names.has('sequence') || names.has('consecutive') || names.has('gap') || names.has('prefix');
  const needLevels = names.has('levels') || names.has('mine') || names.has('blocks') || names.has('lead') || names.has('complete');
  const needMine = names.has('mine') || names.has('complete');
  const needRatings = names.has('ratings');
  const needDifficulty = names.has('difficulty');
  const liveDifficulty = needDifficulty && cacheableOwnerIdentities(def, input);
  const needScopedPasses = needClears
    || (needMine && def.audience !== 'creator')
    || (needDifficulty && !liveDifficulty);
  const passes = needScopedPasses ? scopedPasses(def, input) : [];
  const clears = needClears ? passes.map((pass) => clearRecord(def, input, pass)) : [];
  if (needClears) markFirstClears(clears);
  const frozen = input.frozenIds ? new Set(input.frozenIds) : null;
  const charts = !needLevels ? [] : frozen ? input.charts.filter((chart) => frozen.has(chart.id)) : input.charts;
  const levels = charts.map((chart) => levelRecord(def, input, chart));
  const clearedLevelIds = needMine && def.audience !== 'creator'
    ? new Set(passes.map((pass) => pass.levelId))
    : null;
  const mine = !needMine
    ? []
    : def.audience === 'creator'
      ? levels.filter((level) => rowVal(level, 'ownerIsCharter') === true || rowVal(level, 'ownerIsVfxer') === true)
      : levels.filter((level) => clearedLevelIds?.has(rowNum(level, 'levelId') ?? -1));
  const clearedIdentities = needDifficulty && !liveDifficulty ? ownerClearedIdentities(def, input, passes) : null;
  return new Map<string, Value>([
    ['clears', clears],
    ['levels', levels],
    ['mine', mine],
    ['count', fn((args) => {
      const list = rowsOf(args[0] ?? null);
      if (matchedPasses) {
        for (const item of list) {
          const id = rowNum(item, 'passId');
          if (id != null) matchedPasses.add(id);
        }
      }
      return list.length;
    })],
    ['threshold', fn((args) => {
      const value = valueAsNumber(args[0] ?? null);
      const cutoff = valueAsNumber(args[1] ?? null);
      return value != null && cutoff != null && value >= cutoff ? 1 : 0;
    })],
    ['distinct', fn((args) => {
      const list = rowsOf(args[0] ?? null);
      const pred = args[1];
      const seen = new Set<string>();
      const out: Value[] = [];
      for (const item of list) {
        const key = pred && typeof pred === 'object' && !Array.isArray(pred) && pred.kind === 'fn'
          ? JSON.stringify(pred.call([item]))
          : JSON.stringify(item);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
      }
      return out;
    })],
    ['sum', fn((args) => {
      const list = rowsOf(args[0] ?? null);
      const pred = args[1];
      return list.reduce<number>((total, item) => {
        const raw = isFn(pred) ? pred.call([item]) : item;
        return total + (valueAsNumber(raw) ?? 0);
      }, 0);
    })],
    ['min', fn((args) => reduceNum(args, Math.min))],
    ['max', fn((args) => reduceNum(args, Math.max))],
    ['maxCount', fn((args) => maxCount(rowsOf(args[0] ?? null), String(args[1] ?? ''), matchedPasses))],
    ['abs', fn((args) => Math.abs(valueAsNumber(args[0] ?? null) ?? 0))],
    ['floor', fn((args) => Math.floor(valueAsNumber(args[0] ?? null) ?? 0))],
    ['round', fn((args) => Math.round(valueAsNumber(args[0] ?? null) ?? 0))],
    ['ceil', fn((args) => Math.ceil(valueAsNumber(args[0] ?? null) ?? 0))],
    ['sequence', fn((args) => matchSequence(clears, numberList(args[0] ?? null), false, args[1]))],
    ['consecutive', fn((args) => matchSequence(clears, numberList(args[0] ?? null), true, args[1]))],
    ['blocks', fn((args) => blockCount(Number(args[0] ?? 0), args.slice(1).map((item) => String(item ?? '')), levels, clears))],
    ['chase', fn((args) => {
      const frozen = input.frozenIds ? new Set(input.frozenIds) : null;
      const progress = chaseProgress(
        input.charts,
        scopedPasses(def, input).map((pass) => pass.levelId),
        args.map((arg) => String(arg ?? '')),
        frozen,
      );
      return row(progress);
    })],
    ['nth', fn((args) => nthCount(def, input, Number(args[0] ?? 0)))],
    ['lead', fn((args) => leadValue(input, args[0] ?? null, String(args[1] ?? 'accuracy')))],
    ['first', fn((args) => {
      const levelId = rowNum(args[0] ?? null, 'levelId');
      if (levelId == null) return false;
      return worldOnLevel(input.world, levelId).some((pass) => pass.playerId === input.ownerId && pass.isWorldsFirst);
    })],
    ['shared', fn(() => sharedCount(def, input))],
    ['inSet', fn((args) => inSet(input, args[0] ?? null, String(args[1] ?? '')))],
    ['difficulty', fn((args) => difficultyValue(
      String(args[0] ?? ''),
      def,
      input,
      clearedIdentities,
      captured,
      difficultyMemo,
    ))],
    ['curve', fn((args) => curveResult(args[0] ?? null, args[1] ?? null, args[2] ?? null, 'up'))],
    ['curveDown', fn((args) => curveResult(args[0] ?? null, args[1] ?? null, args[2] ?? null, 'down'))],
    ['result', fn((args) => row({
      tier: valueAsNumber(args[0] ?? null) ?? 0,
      credit: args[1] == null ? (valueAsNumber(args[0] ?? null) ?? 0) : (valueAsNumber(args[1]) ?? 0),
      from: valueAsNumber(args[2] ?? null) ?? 0,
      to: valueAsNumber(args[3] ?? null) ?? 1,
    }))],
    ['prefix', fn((args) => prefixCount(input, clears, String(args[0] ?? '')))],
    ['gap', fn(() => maxGapDays(clears))],
    ['pack', fn(() => {
      const byId = indexCharts(input.charts, input.links).byId;
      return (input.packLevels[def.params.packId ?? 0] ?? []).filter((id) => byId.has(id));
    })],
    ['maxGroup', fn((args) => maxGroup(rowsOf(args[0] ?? null), String(args[1] ?? ''), String(args[2] ?? '')))],
    ['complete', fn((args) => {
      const set = input.sets[String(args[0] ?? '')];
      if (!set || !set.values.length) return 0;
      const have = new Set(
        mine
          .filter((level) => rowVal(level, 'ownerIsCharter') === true)
          .map((level) => String(rowVal(level, 'difficulty') ?? '')),
      );
      return (set.values as (string | number)[]).every((value) => have.has(String(value))) ? 1 : 0;
    })],
    ['ratings', needRatings
      ? input.ratings.map((rating) => row({ levelId: rating.levelId, week: isoWeek(rating.createdAt) }))
      : []],
  ]);
}

function reduceNum(args: Value[], pick: (a: number, b: number) => number): number | null {
  if (args.length === 2 && !Array.isArray(args[0]) && !Array.isArray(args[1])) {
    const left = valueAsNumber(args[0] ?? null);
    const right = valueAsNumber(args[1] ?? null);
    if (left == null || right == null) return null;
    return pick(left, right);
  }
  const list = rowsOf(args[0] ?? null);
  const pred = args[1];
  let best: number | null = null;
  for (const item of list) {
    const value = valueAsNumber(
      pred && typeof pred === 'object' && !Array.isArray(pred) && pred.kind === 'fn' ? pred.call([item]) : item,
    );
    if (value == null) continue;
    best = best == null ? value : pick(best, value);
  }
  return best;
}

function blockCount(size: number, exclude: string[], levels: Value[], clears: Value[]): number {
  if (!(size > 0)) return 0;
  const excluded = new Set(exclude.map((name) => name.toLowerCase()));
  const have = new Set(clears.map((clear) => rowNum(clear, 'levelId')));
  const byId = new Map(levels.map((level) => [rowNum(level, 'levelId'), level]));
  const maxId = levels.reduce<number>((max, level) => Math.max(max, rowNum(level, 'levelId') ?? 0), 0);
  let completed = 0;
  for (let start = 1; start <= maxId; start += size) {
    let required = 0;
    let got = 0;
    for (let id = start; id < start + size; id += 1) {
      const level = byId.get(id);
      if (!level) continue;
      const name = String(rowVal(level, 'difficulty') ?? '');
      if (excluded.has(name.toLowerCase())) continue;
      required += 1;
      if (have.has(id)) got += 1;
    }
    if (required === 0 || got === required) completed += 1;
    else break;
  }
  return completed;
}

function nthCount(def: BadgeDraft, input: OwnerInput, n: number): number {
  if (!Number.isInteger(n) || n < 1) return 0;
  const byKey = new Map<string, WorldPass[]>();
  for (const pass of input.world) {
    throwIfBadgeCancelled();
    if (!pass.uploadTimeKnown || !pass.vidUploadTime) continue;
    const key = keyFor(def, input, pass.levelId);
    const list = byKey.get(key) ?? [];
    list.push(pass);
    byKey.set(key, list);
  }
  let credit = 0;
  for (const list of byKey.values()) {
    list.sort((a, b) => Date.parse(a.vidUploadTime || '') - Date.parse(b.vidUploadTime || '') || a.passId - b.passId);
    const seen: number[] = [];
    for (const pass of list) {
      if (!seen.includes(pass.playerId)) seen.push(pass.playerId);
    }
    if (seen[n - 1] === input.ownerId) credit += 1;
  }
  return credit;
}

function leadValue(input: OwnerInput, level: Value, metric: string): boolean {
  const levelId = rowNum(level, 'levelId');
  if (levelId == null) return false;
  const passes = worldOnLevel(input.world, levelId).filter((pass) => metric === 'speed' || !pass.ancient);
  const valueOf = (pass: WorldPass) => {
    if (metric === 'speed') return Number(pass.speed);
    if (metric === 'score') return Number(pass.scoreV2);
    return Number(pass.accuracy);
  };
  let best = -Infinity;
  for (const pass of passes) {
    const value = valueOf(pass);
    if (Number.isFinite(value) && value > best) best = value;
  }
  if (!Number.isFinite(best)) return false;
  return passes.some((pass) => pass.playerId === input.ownerId && valueOf(pass) === best);
}

function sharedCount(def: BadgeDraft, input: OwnerInput): number {
  const groups = new Map<string, WorldPass[]>();
  for (const pass of input.world) {
    throwIfBadgeCancelled();
    if (ignoredAccuracy(pass)) continue;
    const chart = chartOf(input, pass.levelId);
    const family = difficultyFamily(chart?.diffName);
    if (family !== 'G' && family !== 'U') continue;
    const rendered = formatAccuracyRatio(pass.accuracy);
    const list = groups.get(rendered) ?? [];
    list.push(pass);
    groups.set(rendered, list);
  }
  const mine = new Set<number>();
  for (const list of groups.values()) {
    const players = new Set(list.map((pass) => pass.playerId));
    const identities = new Set(list.map((pass) => keyFor(def, input, pass.levelId)));
    if (players.size < 2 || identities.size < 2) continue;
    for (const pass of list) {
      if (pass.playerId !== input.ownerId) continue;
      const shared = list.some((other) => other.playerId !== pass.playerId && keyFor(def, input, other.levelId) !== keyFor(def, input, pass.levelId));
      if (shared) mine.add(pass.levelId);
    }
  }
  return mine.size;
}

function inSet(input: OwnerInput, item: Value, name: string): boolean {
  const set = input.sets[name];
  if (!set) return false;
  const values = new Set((set.values as (string | number)[]).map((value) => String(value)));
  if (typeof item === 'string' || typeof item === 'number') return values.has(String(item));
  return values.has(String(rowVal(item, 'difficulty') ?? rowVal(item, 'levelId') ?? ''));
}

function curveResult(credit: Value, start: Value, step: Value, direction: 'up' | 'down'): Value {
  if (typeof credit !== 'number' || !Number.isFinite(credit)) {
    return row({ tier: 0, credit: 0, from: 0, to: valueAsNumber(start) ?? 1 });
  }
  const curve = {
    start: valueAsNumber(start) ?? 1,
    step: valueAsNumber(step) ?? 1,
    round: 'none' as const,
    direction,
  };
  const tier = tierForCredit(curve, credit);
  const bar = barForCredit(curve, credit, tier);
  return row({ tier, credit, from: bar.from, to: bar.to });
}

function prefixCount(input: OwnerInput, clears: Value[], name: string): number {
  const set = input.sets[name];
  if (!set) return 0;
  const have = new Set(clears.map((clear) => String(rowVal(clear, 'difficultyAt') ?? '')));
  let count = 0;
  for (const value of set.values) {
    if (!have.has(String(value))) break;
    count += 1;
  }
  return count;
}

function maxGapDays(clears: Value[]): number {
  const groups = new Map<string, Value[]>();
  for (const clear of clears) {
    if (rowNum(clear, 'uploadMs') == null) continue;
    const key = String(rowVal(clear, 'identity') ?? '');
    const list = groups.get(key) ?? [];
    list.push(clear);
    groups.set(key, list);
  }
  let best = 0;
  for (const list of groups.values()) {
    const timed = [...list].sort((a, b) => (rowNum(a, 'uploadMs') ?? 0) - (rowNum(b, 'uploadMs') ?? 0));
    for (let index = 1; index < timed.length; index += 1) {
      const days = ((rowNum(timed[index], 'uploadMs') ?? 0) - (rowNum(timed[index - 1], 'uploadMs') ?? 0)) / 86400000;
      if (days > best) best = days;
    }
  }
  return best;
}

function maxCount(list: Value[], field: string, matchedPasses?: Set<number>): number {
  const groups = new Map<string, Value[]>();
  for (const item of list) {
    const key = String(rowVal(item, field) ?? '');
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  let best: Value[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length > best.length) best = bucket;
  }
  if (matchedPasses) {
    for (const item of best) {
      const id = rowNum(item, 'passId');
      if (id != null) matchedPasses.add(id);
    }
  }
  return best.length;
}

function maxGroup(list: Value[], groupName: string, valueName: string): number {
  const groups = new Map<string, Set<string>>();
  for (const item of list) {
    const raw = rowVal(item, groupName);
    const ids = Array.isArray(raw) ? raw : [raw];
    const value = String(rowVal(item, valueName) ?? '');
    for (const id of ids) {
      if (id == null || id === '') continue;
      const set = groups.get(String(id)) ?? new Set<string>();
      set.add(value);
      groups.set(String(id), set);
    }
  }
  let best = 0;
  for (const set of groups.values()) best = Math.max(best, set.size);
  return best;
}

function difficultyValue(
  name: string,
  def: BadgeDraft,
  input: OwnerInput,
  clearedIdentities: Set<string> | null,
  captured?: Set<number>,
  memo?: Map<string, Value>,
): Value {
  const cached = memo?.get(name);
  if (cached) return cached;
  const table = catalogDifficultyCoverage(input.charts, input.links, def.identity);
  let total = 0;
  let cleared = 0;
  let ratio: number | null = null;
  let captureIds: number[] = [];
  if (input.frozenIds) {
    const sliced = frozenDifficultyCount(
      table,
      name,
      new Set(input.frozenIds),
      clearedIdentities ?? ownerClearedIdentities(def, input),
    );
    total = sliced.count.total;
    cleared = sliced.count.cleared;
    ratio = sliced.count.ratio;
    captureIds = sliced.levelIds;
  } else {
    const counts = input.difficultyCounts?.[def.identity]
      ?? (cacheableOwnerIdentities(def, input)
        ? cachedOwnerDifficultyCounts(input.charts, input.links, def.identity, input.passes)
        : ownerDifficultyCounts(table, clearedIdentities ?? ownerClearedIdentities(def, input)));
    const count = lookupDifficultyCount(counts, name);
    total = count.total;
    cleared = count.cleared;
    ratio = count.ratio;
    captureIds = table.byName.get(name)?.levelIds ?? [];
  }
  if (captured) {
    for (const id of captureIds) captured.add(id);
  }
  const value = row({ total, cleared, ratio });
  memo?.set(name, value);
  return value;
}

function planTruth(value: Value): boolean {
  if (value == null || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  return true;
}

function planBinary(op: string, left: Value, right: Value): Value {
  if (op === '==' || op === '===') return left === right || String(left) === String(right);
  if (op === '!=' || op === '!==') return !(left === right || String(left) === String(right));
  if (op === '+' && (typeof left === 'string' || typeof right === 'string')) return `${left ?? ''}${right ?? ''}`;
  const a = valueAsNumber(left);
  const b = valueAsNumber(right);
  if (a == null || b == null) return false;
  if (op === '+') return a + b;
  if (op === '-') return a - b;
  if (op === '*') return a * b;
  if (op === '/') return b === 0 ? null : a / b;
  if (op === '%') return b === 0 ? null : a % b;
  if (op === '>') return a > b;
  if (op === '>=') return a >= b;
  if (op === '<') return a < b;
  if (op === '<=') return a <= b;
  return null;
}

function evalPlanNode(node: PlanNode, slots: RollupSlots): Value {
  switch (node.type) {
    case 'lit':
      return node.value;
    case 'slot': {
      const slot = slots.get(node.key);
      if (node.as === 'coverage') {
        const coverage = slot?.coverage;
        return row({
          total: coverage?.total ?? 0,
          cleared: coverage?.cleared ?? 0,
          ratio: coverage?.ratio ?? null,
        });
      }
      if (node.as === 'chase') {
        const chase = slot?.chase;
        return row({
          tier: chase?.tier ?? 0,
          credit: chase?.credit ?? 0,
          from: chase?.from ?? 0,
          to: chase?.to ?? 1,
        });
      }
      return slot?.n ?? 0;
    }
    case 'member': {
      const base = evalPlanNode(node.a, slots);
      if (base && typeof base === 'object' && !Array.isArray(base) && base.kind === 'row') {
        return base.fields[node.name] ?? null;
      }
      return null;
    }
    case 'un': {
      const inner = evalPlanNode(node.a, slots);
      if (node.op === '!') return !planTruth(inner);
      const num = valueAsNumber(inner);
      return num == null ? null : -num;
    }
    case 'bin':
      return planBinary(node.op, evalPlanNode(node.a, slots), evalPlanNode(node.b, slots));
    case 'and': {
      const left = evalPlanNode(node.a, slots);
      return planTruth(left) ? evalPlanNode(node.b, slots) : left;
    }
    case 'or': {
      const left = evalPlanNode(node.a, slots);
      return planTruth(left) ? left : evalPlanNode(node.b, slots);
    }
    case 'if':
      return planTruth(evalPlanNode(node.c, slots)) ? evalPlanNode(node.a, slots) : evalPlanNode(node.b, slots);
    case 'curve':
      return curveResult(
        evalPlanNode(node.credit, slots),
        evalPlanNode(node.start, slots),
        evalPlanNode(node.step, slots),
        node.down ? 'down' : 'up',
      );
    case 'result':
      return row({
        tier: valueAsNumber(evalPlanNode(node.tier, slots)) ?? 0,
        credit: valueAsNumber(evalPlanNode(node.credit, slots)) ?? 0,
        from: valueAsNumber(evalPlanNode(node.from, slots)) ?? 0,
        to: valueAsNumber(evalPlanNode(node.to, slots)) ?? 1,
      });
    default:
      return null;
  }
}

function finalizeValue(result: EvalResult, value: Value, provingPassIds: number[], captured: Set<number>, grant: BadgeDraft['grant']): EvalResult {
  const snapshotIds = grant === 'persistSnapshot' && captured.size > 0 ? [...captured] : null;
  if (value && typeof value === 'object' && !Array.isArray(value) && value.kind === 'row' && typeof value.fields.tier === 'number') {
    const tier = Math.max(0, Math.floor(value.fields.tier));
    const credit = typeof value.fields.credit === 'number' ? value.fields.credit : tier;
    const from = typeof value.fields.from === 'number' ? value.fields.from : 0;
    const to = typeof value.fields.to === 'number' ? value.fields.to : 1;
    return { ...result, tier, credit, barFrom: from, barTo: to, barValue: credit, provingPassIds, snapshotIds };
  }
  const num = valueAsNumber(value);
  if (num == null) return result;
  const tier = num >= 1 ? Math.floor(num + 1e-9) : 0;
  return { ...result, tier, credit: num, barFrom: 0, barTo: Math.max(1, tier + 1), barValue: num, provingPassIds, snapshotIds };
}

function evaluateValue(def: BadgeDraft, input: OwnerInput): EvalResult {
  const result = emptyResult();
  const matchedPasses = new Set<number>();
  const captured = new Set<number>();
  try {
    const parsed = parseValueExpr(def.params.expression || '');
    if (!parsed.ok) return result;
    const plan = planValueExpr(parsed.ast, { identityMode: def.identity, source: def.params.expression || '' });
    const sharedOk = !input.frozenIds && def.grant !== 'manualLock' && def.backfill !== 'forward';
    if (plan.pure && sharedOk) {
      let slots = input.rollups;
      if (!slots || plan.demands.some((demand) => !slots!.has(demand.key))) {
        slots = computeRollups({
          passes: scopedPasses(def, input),
          charts: input.charts,
          links: input.links,
          ownerId: input.ownerId,
          difficultyCounts: input.difficultyCounts,
        }, plan.demands);
      }
      const value = evalPlanNode(plan.node, slots);
      for (const key of collectPlanSlotKeys(plan.node)) {
        const slot = slots.get(key);
        for (const id of slot?.provingPassIds ?? []) matchedPasses.add(id);
        for (const id of slot?.coverage?.levelIds ?? []) captured.add(id);
      }
      return finalizeValue(result, value, [...matchedPasses], captured, def.grant);
    }
    const names = valueExprNames(parsed.ast);
    const difficultyMemo = new Map<string, Value>();
    const value = evalValueExpr(parsed.ast, valueScope(def, input, names, captured, matchedPasses, difficultyMemo));
    return finalizeValue(result, value, [...matchedPasses], captured, def.grant);
  } catch (error) {
    if (error instanceof BadgeJobCancelled) throw error;
    return result;
  }
}

export function evaluateBadge(def: BadgeDraft, input: OwnerInput): EvalResult {
  throwIfBadgeCancelled();
  let result: EvalResult;
  switch (def.reducer) {
    case 'threshold':
      result = evaluateThreshold(def, input);
      break;
    case 'coverage':
      result = evaluateCoverage(def, input);
      break;
    case 'percentOf':
      result = evaluatePercent(def, input);
      break;
    case 'record':
      result = evaluateRecord(def, input);
      break;
    case 'pattern':
      result = evaluatePattern(def, input, def.params);
      break;
    case 'sequence':
      result = evaluateSequence(def, input, def.params);
      break;
    case 'gap':
      result = evaluateGap(def, input);
      break;
    case 'nthClearer':
      result = evaluateNth(def, input);
      break;
    case 'chase':
      result = evaluateChase(def, input);
      break;
    case 'best':
      result = evaluateBest(def, input);
      break;
    case 'pack':
      result = evaluatePack(def, input);
      break;
    case 'manual':
      result = def.params.kind === 'sequence'
        ? evaluateSequence(def, input, def.params.sequence ?? {})
        : evaluatePattern(def, input, def.params.pattern ?? {});
      break;
    case 'value':
      result = evaluateValue(def, input);
      break;
    default:
      result = emptyResult();
  }
  if (def.grant === 'manualLock' || def.backfill === 'queue') {
    const approved = new Set(
      input.reviews
        .filter((review) => review.definitionId === def.id && review.status === 'approved')
        .map((review) => review.passId),
    );
    const proving = result.reviewPassIds.length ? result.reviewPassIds : result.provingPassIds;
    result.reviewPassIds = proving;
    if (def.grant === 'manualLock' && !proving.some((id) => approved.has(id))) {
      result.tier = 0;
      result.earnedAt = null;
    }
  }
  return shown(def, result);
}
