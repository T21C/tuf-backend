import {parseQRange} from '@/misc/utils/data/communityTagEligibility.js';

function parseRatingRange(
  rating: string,
  specialDifficulties: Set<string>,
): string[] {
  if (specialDifficulties.has(rating.trim())) {
    return [rating.trim()];
  }

  const match = rating.match(/([^-~\s]+|^-\d+)([-~\s])(.+)/);
  if (!match) {
    return [rating.trim()];
  }

  const firstPart = match[1];
  const lastPart = match[3];
  if (!firstPart || lastPart == null) {
    return [rating.trim()];
  }

  if (specialDifficulties.has(lastPart)) {
    return [firstPart, lastPart];
  }

  const firstMatch = firstPart.match(/([PGUpgu]*)(-?\d+)/);
  const lastMatch = lastPart.match(/([PGUpgu]*)(-?\d+)/);

  if (firstMatch && lastMatch) {
    const firstPrefix = firstMatch[1];
    const lastPrefix = lastMatch[1];
    const lastNum = lastMatch[2];
    if (!lastPrefix && firstPrefix && lastNum) {
      const rawSecondPart = lastNum;
      if (specialDifficulties.has(rawSecondPart)) {
        return [firstPart, rawSecondPart];
      }
      return [firstPart, `${firstPrefix}${lastNum}`];
    }
  }

  return [firstPart, lastPart];
}

export const RATING_ACCURACY_TAU = 2;
export const RATING_ACCURACY_Q_TAU = 3;
export const RATING_ACCURACY_PRIOR_N = 10;
export const RATING_ACCURACY_PRIOR_MEAN = 0.5;
export const RATING_ACCURACY_PROVISIONAL_N = 10;
export const RATING_ACCURACY_CHART_PAD = 8;

export type RatingAccuracyTrack = 'pgu' | 'special' | 'skip';
export type RatingAccuracyScoringMode = 'rank' | 'q' | 'special';

export type DifficultyRef = {
  id: number;
  name: string;
  type: string;
  sortOrder: number;
};

export type RatingAccuracyChartPoint = {
  name: string;
  k: number;
  inRange: boolean;
  phantom?: boolean;
};

export type RatingAccuracyChart = {
  points: RatingAccuracyChartPoint[];
  plateauNames: string[];
  centerName: string | null;
  settledName: string;
  scoredRankNames: string[];
  specialTokens: string[];
};

export type RatingAccuracyResult = {
  track: RatingAccuracyTrack;
  scoringMode: RatingAccuracyScoringMode;
  score: number | null;
  scoredRankNames: string[];
  specialTokens: string[];
  chart: RatingAccuracyChart;
};

export type SettleKernel = {
  scoringMode: RatingAccuracyScoringMode;
  plateau: DifficultyRef[];
  center: DifficultyRef | null;
};

const PGU_LETTER = /^([PGU])([1-9]|1[0-9]|20)$/i;

export function shrinkMean(raw: number, n: number): number {
  if (!Number.isFinite(raw) || n <= 0) {
    return RATING_ACCURACY_PRIOR_MEAN;
  }
  return (
    (n * raw + RATING_ACCURACY_PRIOR_N * RATING_ACCURACY_PRIOR_MEAN) /
    (n + RATING_ACCURACY_PRIOR_N)
  );
}

function normalizeName(name: string): string {
  return String(name || '').trim();
}

function pguList(difficulties: DifficultyRef[]): DifficultyRef[] {
  return difficulties
    .filter((d) => String(d.type || '').toUpperCase() === 'PGU')
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function specialNameSet(difficulties: DifficultyRef[]): Set<string> {
  const names = new Set<string>();
  for (const d of difficulties) {
    const type = String(d.type || '').toUpperCase();
    if (type === 'SPECIAL' || type === 'LEGACY') {
      names.add(d.name);
    }
  }
  return names;
}

function findPguByName(pgu: DifficultyRef[], raw: string): DifficultyRef | null {
  const t = normalizeName(raw);
  if (!t) return null;
  const upper = t.toUpperCase();
  const match = t.match(PGU_LETTER);
  const canonical = match ? `${match[1].toUpperCase()}${match[2]}` : upper;
  return pgu.find((d) => d.name.toUpperCase() === canonical) ?? null;
}

function findByName(difficulties: DifficultyRef[], raw: string): DifficultyRef | null {
  const t = normalizeName(raw);
  if (!t) return null;
  const upper = t.toUpperCase();
  return (
    difficulties.find((d) => d.name === t) ??
    difficulties.find((d) => d.name.toUpperCase() === upper) ??
    null
  );
}

function plateauFromParsed(
  parsed: {letter: string; tier: number},
  pgu: DifficultyRef[],
): DifficultyRef[] {
  const start = parsed.tier * 4 + 1;
  const names = [0, 1, 2, 3].map((i) => `${parsed.letter}${start + i}`);
  return names
    .map((name) => pgu.find((d) => d.name.toUpperCase() === name.toUpperCase()) ?? null)
    .filter((d): d is DifficultyRef => d != null);
}

function ranksBetween(a: DifficultyRef, b: DifficultyRef, pgu: DifficultyRef[]): DifficultyRef[] {
  const lo = Math.min(a.sortOrder, b.sortOrder);
  const hi = Math.max(a.sortOrder, b.sortOrder);
  return pgu.filter((d) => d.sortOrder >= lo && d.sortOrder <= hi);
}

function uniqueById(list: DifficultyRef[]): DifficultyRef[] {
  const seen = new Set<number>();
  const out: DifficultyRef[] = [];
  for (const d of list) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    out.push(d);
  }
  return out.sort((a, b) => a.sortOrder - b.sortOrder);
}

export function collectPlayerRanksAndSpecials(
  frozenRating: string,
  difficulties: DifficultyRef[],
): {ranks: DifficultyRef[]; specials: string[]} {
  const input = normalizeName(frozenRating);
  if (!input) {
    return {ranks: [], specials: []};
  }
  const pgu = pguList(difficulties);
  const specialsSet = specialNameSet(difficulties);
  const parts = parseRatingRange(input, specialsSet);
  const specials: string[] = [];
  const qRanks: DifficultyRef[] = [];
  const endpoints: DifficultyRef[] = [];

  for (const part of parts) {
    const token = normalizeName(part);
    if (!token) continue;
    const q = parseQRange(token);
    if (q) {
      qRanks.push(...plateauFromParsed(q, pgu));
      continue;
    }
    const specialMatch =
      findByName(difficulties, token) &&
      (specialsSet.has(token) ||
        specialsSet.has(token.toUpperCase()) ||
        [...specialsSet].some((n) => n.toUpperCase() === token.toUpperCase()));
    if (specialMatch) {
      const named = findByName(difficulties, token);
      if (named) specials.push(named.name);
      else specials.push(token);
      continue;
    }
    const pguRank = findPguByName(pgu, token);
    if (pguRank) {
      endpoints.push(pguRank);
    }
  }

  let filled: DifficultyRef[] = [];
  if (endpoints.length >= 2) {
    filled = ranksBetween(endpoints[0], endpoints[1], pgu);
  } else if (endpoints.length === 1) {
    filled = [endpoints[0]];
  }

  return {
    ranks: uniqueById([...filled, ...qRanks]),
    specials: [...new Set(specials)],
  };
}

export function settleKernel(
  settled: DifficultyRef,
  clearsAtSettle: number | null | undefined,
  difficulties: DifficultyRef[],
): SettleKernel {
  const pgu = pguList(difficulties);
  const q = parseQRange(settled.name);
  if (q) {
    return {
      scoringMode: 'q',
      plateau: plateauFromParsed(q, pgu),
      center: null,
    };
  }

  const pMatch = normalizeName(settled.name).match(PGU_LETTER);
  const isP =
    String(settled.type || '').toUpperCase() === 'PGU' &&
    pMatch?.[1]?.toUpperCase() === 'P';
  if (isP && (clearsAtSettle ?? 0) === 0) {
    const n = Number(pMatch[2]);
    const tier = Math.min(Math.max(Math.floor((n - 1) / 4), 0), 4);
    return {
      scoringMode: 'q',
      plateau: plateauFromParsed({letter: 'P', tier}, pgu),
      center: null,
    };
  }

  if (String(settled.type || '').toUpperCase() === 'PGU') {
    return {scoringMode: 'rank', plateau: [], center: settled};
  }

  return {scoringMode: 'special', plateau: [], center: null};
}

function pguIndexById(pgu: DifficultyRef[]): Map<number, number> {
  const map = new Map<number, number>();
  pgu.forEach((d, i) => map.set(d.id, i));
  return map;
}

function kernelValueAtIndex(
  index: number,
  kernel: SettleKernel,
  indexById: Map<number, number>,
  tau: number,
): number {
  if (kernel.scoringMode === 'q') {
    const plateauIdx: number[] = [];
    for (const p of kernel.plateau) {
      const i = indexById.get(p.id);
      if (i != null) plateauIdx.push(i);
    }
    if (plateauIdx.length === 0) {
      return 0;
    }
    if (plateauIdx.includes(index)) {
      return 1;
    }
    const d = Math.min(...plateauIdx.map((p) => Math.abs(index - p)));
    return Math.exp(-d / tau);
  }
  if (kernel.scoringMode === 'rank' && kernel.center) {
    const centerIdx = indexById.get(kernel.center.id);
    if (centerIdx == null) {
      return 0;
    }
    return Math.exp(-Math.abs(index - centerIdx) / tau);
  }
  return 0;
}

function buildChart(
  difficulties: DifficultyRef[],
  kernel: SettleKernel,
  playerRanks: DifficultyRef[],
  specials: string[],
  tau: number,
): RatingAccuracyChart {
  const pgu = pguList(difficulties);
  const indexById = pguIndexById(pgu);
  const plateauNames = kernel.plateau.map((d) => d.name);
  const centerName = kernel.center?.name ?? null;
  const scoredRankNames = playerRanks.map((d) => d.name);
  const inRangeIds = new Set(playerRanks.map((d) => d.id));

  const anchors: DifficultyRef[] = [
    ...kernel.plateau,
    ...(kernel.center ? [kernel.center] : []),
    ...playerRanks,
  ];
  if (anchors.length === 0 || kernel.scoringMode === 'special') {
    return {
      points: [],
      plateauNames,
      centerName,
      settledName: '',
      scoredRankNames,
      specialTokens: specials,
    };
  }

  const anchorIdx = anchors
    .map((d) => indexById.get(d.id))
    .filter((n): n is number => n != null);
  if (anchorIdx.length === 0) {
    return {
      points: [],
      plateauNames,
      centerName,
      settledName: '',
      scoredRankNames,
      specialTokens: specials,
    };
  }

  const lo = Math.max(0, Math.min(...anchorIdx) - RATING_ACCURACY_CHART_PAD);
  const hi = Math.min(pgu.length - 1, Math.max(...anchorIdx) + RATING_ACCURACY_CHART_PAD);
  const points: RatingAccuracyChartPoint[] = [];
  for (let i = lo; i <= hi; i += 1) {
    const real = pgu[i];
    if (!real) continue;
    points.push({
      name: real.name,
      k: kernelValueAtIndex(i, kernel, indexById, tau),
      inRange: inRangeIds.has(real.id),
    });
  }

  return {
    points,
    plateauNames,
    centerName,
    settledName: '',
    scoredRankNames,
    specialTokens: specials,
  };
}

export function scoreRatingAccuracy(input: {
  frozenRating: string;
  settled: DifficultyRef;
  clearsAtSettle: number | null | undefined;
  difficulties: DifficultyRef[];
  tau?: number;
}): RatingAccuracyResult {
  const {ranks, specials} = collectPlayerRanksAndSpecials(
    input.frozenRating,
    input.difficulties,
  );
  const kernel = settleKernel(input.settled, input.clearsAtSettle, input.difficulties);
  const tau =
    input.tau ??
    (kernel.scoringMode === 'q' ? RATING_ACCURACY_Q_TAU : RATING_ACCURACY_TAU);
  const pgu = pguList(input.difficulties);
  const indexById = pguIndexById(pgu);

  const chart = buildChart(input.difficulties, kernel, ranks, specials, tau);
  chart.settledName = input.settled.name;

  if (ranks.length === 0 && specials.length === 0) {
    return {
      track: 'skip',
      scoringMode: kernel.scoringMode,
      score: null,
      scoredRankNames: [],
      specialTokens: [],
      chart,
    };
  }

  if (kernel.scoringMode === 'special') {
    const settledName = normalizeName(input.settled.name).toUpperCase();
    const hit = specials.some((s) => s.toUpperCase() === settledName);
    return {
      track: 'special',
      scoringMode: 'special',
      score: hit ? 1 : 0,
      scoredRankNames: [],
      specialTokens: specials,
      chart,
    };
  }

  if (ranks.length === 0) {
    return {
      track: 'pgu',
      scoringMode: kernel.scoringMode,
      score: 0,
      scoredRankNames: [],
      specialTokens: specials,
      chart,
    };
  }

  const mean =
    ranks.reduce((sum, rank) => {
      const idx = indexById.get(rank.id);
      if (idx == null) return sum;
      return sum + kernelValueAtIndex(idx, kernel, indexById, tau);
    }, 0) / ranks.length;
  return {
    track: 'pgu',
    scoringMode: kernel.scoringMode,
    score: mean,
    scoredRankNames: ranks.map((d) => d.name),
    specialTokens: specials,
    chart,
  };
}
