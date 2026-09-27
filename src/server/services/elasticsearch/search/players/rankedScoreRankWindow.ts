/**
 * Pure helpers that turn a 1-based inclusive ranked-score rank range into a
 * `rankedScore` window. Rank matches `getRankedScoreRanksForHits`:
 * `1 + count(non-banned players with a strictly higher rankedScore)`.
 *
 * Ties share a rank, so a range that includes that rank includes every player
 * with that score. A rank number that no player holds (a gap inside a tie)
 * yields an empty window.
 */

export type RankedScoreWindow =
  | {type: 'all'}
  | {type: 'empty'}
  | {type: 'range'; gte: number; lt?: number};

export type ClampedRankRange =
  | {kind: 'empty'}
  | {kind: 'all'}
  | {kind: 'range'; min: number; max: number};

export type ScoreRangeBounds = {
  gte?: number;
  lt?: number;
  lte?: number;
};

export function parseRankedScoreRankRange(value: unknown): {min: number; max: number} | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const min = Math.floor(Number(value[0]));
  const max = Math.floor(Number(value[1]));
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return {min, max};
}

export function clampRankRange(
  minRank: number,
  maxRank: number,
  population: number,
): ClampedRankRange {
  if (!Number.isFinite(population) || population < 1) return {kind: 'empty'};
  if (!Number.isFinite(minRank) || !Number.isFinite(maxRank)) return {kind: 'empty'};

  let min = Math.max(1, Math.floor(minRank));
  let max = Math.floor(maxRank);
  if (max < min) {
    const swap = min;
    min = max;
    max = swap;
    min = Math.max(1, min);
  }
  if (min > population) return {kind: 'empty'};
  max = Math.min(max, population);
  if (max < min) return {kind: 'empty'};
  if (min === 1 && max >= population) return {kind: 'all'};
  return {kind: 'range', min, max};
}

/**
 * `scoreAtMax` is the rankedScore of the player at positional index `max`
 * among non-banned players sorted by rankedScore desc.
 * `scoreAtMinMinusOne` is the score at position `min - 1` (only used when min > 1).
 */
export function rankedScoreWindowForClampedRange(
  clamped: Extract<ClampedRankRange, {kind: 'range'}>,
  scores: {atMax: number | null; atMinMinusOne: number | null},
): RankedScoreWindow {
  const lower = scores.atMax;
  if (lower == null || !Number.isFinite(lower)) return {type: 'empty'};

  if (clamped.min <= 1) {
    return {type: 'range', gte: lower};
  }

  const upper = scores.atMinMinusOne;
  if (upper == null || !Number.isFinite(upper)) return {type: 'empty'};
  if (!(lower < upper)) return {type: 'empty'};
  return {type: 'range', gte: lower, lt: upper};
}

export function parseNumericRange(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const min = Number(value[0]);
  const max = Number(value[1]);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return min <= max ? [min, max] : [max, min];
}

/**
 * Merge a rank window with an optional inclusive `rankedScore` stat filter.
 * `null` bounds means no rankedScore constraint should be added.
 */
export function intersectRankedScoreFilters(
  rankWindow: RankedScoreWindow,
  statRange: [number, number] | null,
): {empty: true} | {empty: false; bounds: ScoreRangeBounds | null} {
  if (rankWindow.type === 'empty') return {empty: true};

  let bounds: ScoreRangeBounds | null = null;
  if (rankWindow.type === 'range') {
    bounds = {gte: rankWindow.gte};
    if (rankWindow.lt != null) bounds.lt = rankWindow.lt;
  }

  if (statRange) {
    const [statMin, statMax] = statRange;
    if (!bounds) {
      bounds = {gte: statMin, lte: statMax};
    } else {
      bounds.gte = bounds.gte == null ? statMin : Math.max(bounds.gte, statMin);
      bounds.lte = bounds.lte == null ? statMax : Math.min(bounds.lte, statMax);
    }
  }

  if (!bounds) return {empty: false, bounds: null};
  if (scoreRangeIsEmpty(bounds)) return {empty: true};
  return {empty: false, bounds};
}

export function scoreRangeIsEmpty(bounds: ScoreRangeBounds): boolean {
  const lo = bounds.gte ?? Number.NEGATIVE_INFINITY;
  if (bounds.lt != null && !(lo < bounds.lt)) return true;
  if (bounds.lte != null && lo > bounds.lte) return true;
  return false;
}
