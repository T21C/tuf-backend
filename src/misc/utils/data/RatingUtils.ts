import Difficulty from '@/models/levels/Difficulty.js';
import RatingDetail from '@/models/levels/RatingDetail.js';

// Cache for difficulties to avoid repeated DB queries
let difficultyCache: {
  special: Set<string>;
  map: Map<string, any>;
  nameMap: Map<string, any>;
} | null = null;

let difficultyCacheTimeout: NodeJS.Timeout | null = null;

function setDifficultyCacheTimeout() {
  if (difficultyCacheTimeout) {
    clearTimeout(difficultyCacheTimeout);
  }
  difficultyCacheTimeout = setTimeout(() => {
    difficultyCache = null;
  }, 1000 * 60 * 5); // 5 minutes
}

// Helper function to get difficulties
export async function getDifficulties(transaction: any) {
  if (!difficultyCache) {
    const difficulties = await Difficulty.findAll({
      transaction,
      order: [['sortOrder', 'ASC']],
    });

    setDifficultyCacheTimeout();

    difficultyCache = {
      special: new Set(
        difficulties.filter(d => d.type === 'SPECIAL').map(d => d.name),
      ),
      map: new Map(difficulties.map(d => [d.id.toString(), d])),
      nameMap: new Map(difficulties.map(d => [d.name, d])),
    };
  }
  return difficultyCache;
}

// Helper function to parse complex rating string
export function parseRatingRange(
  rating: string,
  specialDifficulties: Set<string>,
): string[] {
  // First check if the entire rating is a special difficulty
  if (specialDifficulties.has(rating.trim())) {
    return [rating.trim()];
  }

  // Find the first separator, but be careful with negative numbers
  // Look for separator only if it's not part of a negative number
  const match = rating.match(/([^-~\s]+|^-\d+)([-~\s])(.+)/);
  if (!match) {
    return [rating.trim()];
  }

  /* eslint-disable @typescript-eslint/no-unused-vars */
  const [_, firstPart, separator, lastPart] = match;

  // Check if second part is a special rating before any processing
  if (specialDifficulties.has(lastPart)) {
    return [firstPart, lastPart];
  }

  // For number-only second parts in ranges like "U11-13", copy the prefix
  const firstMatch = firstPart.match(/([PGUpgu]*)(-?\d+)/);
  const lastMatch = lastPart.match(/([PGUpgu]*)(-?\d+)/);

  if (firstMatch && lastMatch) {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const [_, firstPrefix, firstNum] = firstMatch;
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const [__, lastPrefix, lastNum] = lastMatch;

    // If second part has no prefix and first part does, copy the prefix
    // BUT only if it's not a special rating
    if (!lastPrefix && firstPrefix) {
      const rawSecondPart = lastNum;
      if (specialDifficulties.has(rawSecondPart)) {
        return [firstPart, rawSecondPart];
      }
      return [firstPart, `${firstPrefix}${lastNum}`];
    }
  }

  return [firstPart, lastPart];
}

/** PGU difficulties closest to `targetSortOrder`; on equal distance prefer higher sortOrder (e.g. 40.5 → U1 not G20). */
function comparePguByDistanceToSortOrder(a: any, b: any, targetSortOrder: number): number {
  const distA = Math.abs(a.sortOrder - targetSortOrder);
  const distB = Math.abs(b.sortOrder - targetSortOrder);
  if (distA !== distB) {
    return distA - distB;
  }
  return b.sortOrder - a.sortOrder;
}

function pickClosestPguDifficulty(difficultyMap: Map<string, any>, targetSortOrder: number): any | null {
  const list = Array.from(difficultyMap.values())
    .filter((d: any) => d.type === 'PGU')
    .sort((a, b) => comparePguByDistanceToSortOrder(a, b, targetSortOrder));
  return list[0] ?? null;
}

/** Set of sortOrder values that exist on at least one PGU difficulty row. */
function buildValidPguSortOrderSet(difficultyMap: Map<string, any>): Set<number> {
  return new Set(
    Array.from(difficultyMap.values())
      .filter((d: any) => d.type === 'PGU')
      .map((d: any) => d.sortOrder as number),
  );
}

/**
 * Map one range endpoint to a PGU ladder sortOrder.
 * Supports named PGU (e.g. G20, U1) and pure ladder indices (e.g. 40, 41) when that sortOrder exists on a PGU row.
 */
function resolvePartToPguSortOrder(
  part: string,
  difficultyMap: Map<string, any>,
  validPguSortOrders: Set<number>,
): number | null {
  const trimmed = part.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return validPguSortOrders.has(n) ? n : null;
  }

  const match = trimmed.match(/^([PGUpgu]+)(-?\d+)$/i);
  if (!match?.[1]) {
    return null;
  }
  const normalizedName = `${match[1].toUpperCase()}${match[2]}`;
  const d = difficultyMap.get(normalizedName);
  if (!d || d.type !== 'PGU') {
    return null;
  }
  return d.sortOrder as number;
}

function collectSpecialsFromParts(parts: string[], specialDifficulties: Set<string>): string[] {
  const names: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (specialDifficulties.has(t)) {
      names.push(t);
    }
  }
  return names;
}

/**
 * Decompose a rating string into specials and a single float on the PGU sortOrder axis.
 * Ranges use the midpoint of the two endpoints in numeric space (e.g. 40~41 → 40.5, G20–U1 → same if those map to 40 and 41).
 * Discrete difficulty is not chosen here — snap only after aggregating (e.g. in calculateAverageRating).
 */
async function getRatingPguNumericAndSpecials(
  rating: string,
  transaction: any,
): Promise<{specialRatings: string[]; pguNumeric: number | null}> {
  if (!rating || rating.trim() === '') {
    return {specialRatings: [], pguNumeric: null};
  }

  const {special: specialDifficulties, nameMap: difficultyMap} = await getDifficulties(transaction);
  const validPguSortOrders = buildValidPguSortOrderSet(difficultyMap);
  const parts = parseRatingRange(rating.trim(), specialDifficulties);
  const specialRatings = [...new Set(collectSpecialsFromParts(parts, specialDifficulties))];

  if (parts.length === 1) {
    const p = parts[0].trim();
    if (specialDifficulties.has(p)) {
      return {specialRatings, pguNumeric: null};
    }
    const letterMatch = p.match(/^([PGUpgu]+)(-?\d+)$/i);
    if (letterMatch?.[1]) {
      const normalizedName = `${letterMatch[1].toUpperCase()}${letterMatch[2]}`;
      if (specialDifficulties.has(normalizedName)) {
        return {
          specialRatings: [...new Set([...specialRatings, normalizedName])],
          pguNumeric: null,
        };
      }
    }
    const so = resolvePartToPguSortOrder(p, difficultyMap, validPguSortOrders);
    return {specialRatings, pguNumeric: so};
  }

  if (parts.length !== 2) {
    return {specialRatings, pguNumeric: null};
  }

  const [rawA, rawB] = parts;
  const pA = rawA.trim();
  const pB = rawB.trim();

  const soA = specialDifficulties.has(pA)
    ? null
    : resolvePartToPguSortOrder(pA, difficultyMap, validPguSortOrders);
  const soB = specialDifficulties.has(pB)
    ? null
    : resolvePartToPguSortOrder(pB, difficultyMap, validPguSortOrders);

  const resolved = [soA, soB].filter((x): x is number => x !== null);

  if (resolved.length === 0) {
    return {specialRatings, pguNumeric: null};
  }
  if (resolved.length === 1) {
    return {specialRatings, pguNumeric: resolved[0]};
  }
  return {specialRatings, pguNumeric: (resolved[0] + resolved[1]) / 2};
}

// Helper function to calculate minimum difficulty from user input
export async function calculateRequestedDifficulty(
  rerateNum: string | null,
  requesterFR: string | null,
): Promise<number | null> {
  // Prioritize rerateNum over requesterFR
  const input = rerateNum || requesterFR;

  if (!input || input.trim() === '') {
    return null;
  }

  const {nameMap} = await getDifficulties(undefined);
  const parts = await parseRatingRange(input.trim(), new Set());

  // If it's not a range, just return the difficulty ID
  if (parts.length === 1) {
    const difficulty = nameMap.get(parts[0]);
    return difficulty?.id || null;
  }

  // For ranges, find the minimum difficulty by sortOrder
  const difficulties = parts
    .map(part => nameMap.get(part))
    .filter(diff => diff !== undefined);

  if (difficulties.length === 0) {
    return null;
  }

  // Find the difficulty with the lowest sortOrder (minimum difficulty)
  const minDifficulty = difficulties.reduce((min, current) =>
    current.sortOrder < min.sortOrder ? current : min
  );

  return minDifficulty.id;
}



// Helper function to normalize rating string and calculate average for ranges
export async function normalizeRating(
  rating: string,
  transaction: any,
): Promise<{pguRating?: string; specialRatings: string[]}> {
  if (!rating) {
    return {specialRatings: []};
  }

  const {nameMap: difficultyMap} = await getDifficulties(transaction);
  const {specialRatings, pguNumeric} = await getRatingPguNumericAndSpecials(rating, transaction);

  if (pguNumeric === null) {
    return {specialRatings};
  }

  const closest = pickClosestPguDifficulty(difficultyMap, pguNumeric);
  return {
    pguRating: closest?.name,
    specialRatings,
  };
}

// Helper function to calculate average rating
export async function calculateAverageRating(
  detailObject: RatingDetail[],
  transaction: any,
  isCommunity = false,
) {
  const {nameMap: difficultyMap} = await getDifficulties(transaction);
  const details = detailObject
    .filter(d => d.isCommunityRating === isCommunity)
    .map((d: any) => d.dataValues);

  // Count votes for each difficulty
  const voteCounts = new Map<string, {count: number; difficulty: any}>();
  let pguNumericSum = 0;
  let pguNumericVoteCount = 0;

  // First pass: Count all votes
  for (const detail of details) {
    if (!detail.rating) continue;

    const {pguNumeric, specialRatings} = await getRatingPguNumericAndSpecials(
      detail.rating,
      transaction,
    );
    // Process special ratings first
    for (const specialRating of specialRatings) {
      const difficulty = difficultyMap.get(specialRating);
      if (!difficulty || difficulty.type !== 'SPECIAL') continue;

      const current = voteCounts.get(specialRating) || {count: 0, difficulty};
      current.count++;
      voteCounts.set(specialRating, current);
    }

    if (pguNumeric !== null) {
      pguNumericSum += pguNumeric;
      pguNumericVoteCount += 1;
    }
  }

  // Check if any special rating has 4 or more votes
  const specialRatings = Array.from(voteCounts.entries())
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    .filter(([_, data]) => data.difficulty.type === 'SPECIAL')
    .sort((a, b) => b[1].count - a[1].count);

  const requiredVotes = isCommunity ? 6 : 4;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const [_, data] of specialRatings) {
    if (data.count >= requiredVotes) {
      return data.difficulty;
    }
  }

  // If no special rating has enough votes, calculate PGU average in numeric space, then snap once
  if (pguNumericVoteCount > 0) {
    const weightedAvgSortOrder = pguNumericSum / pguNumericVoteCount;

    const closest = pickClosestPguDifficulty(difficultyMap, weightedAvgSortOrder);
    if (closest) {
      return closest;
    }
  }


  return null;
}
