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

/**
 * Letter-ladder numeric values (same as client Utility getRatingValue):
 * P1=1 … P20=20, G1=21 … G20=40, U1=41 … U20=60.
 * Universal floor convention: legacy 21 = U1 = Q0.
 */
const PGU_LETTER_BASE: Record<string, number> = { P: 0, G: 20, U: 40 };
const UNIVERSAL_LEGACY_FLOOR = 21;
const UNIVERSAL_PGU_FLOOR = 41; // U1

function stripTrailingPlus(token: string): string {
  return token.replace(/\+$/, '');
}

/** P/G/U token → ladder value, or null if not a PGU letter difficulty. */
function pguLetterLadderValue(token: string): number | null {
  const m = token.trim().match(/^([PGU])([1-9]|1[0-9]|20)$/i);
  if (!m?.[1]) return null;
  const base = PGU_LETTER_BASE[m[1].toUpperCase()];
  if (base === undefined) return null;
  return base + Number(m[2]);
}

/**
 * Legacy feeling token → numeric value (1–21.4), matching validateFeelingRating shapes.
 * Returns null if the token is not a legacy number.
 */
function legacyFeelingValue(token: string): number | null {
  const t = stripTrailingPlus(token.trim());
  if (!/^(?:[1-9]|1[0-9]|20(?:\.\d)?|21(?:\.[0-4])?)$/.test(t)) {
    return null;
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Q0+, UQ*, and Qq specials sit at or above the universal floor. */
function isUniversalSpecialToken(token: string): boolean {
  const t = stripTrailingPlus(token.trim()).toUpperCase();
  if (t === 'QQ') return true;
  if (/^Q\d+$/.test(t)) return true;
  if (/^UQ\d*$/.test(t)) return true;
  return false;
}

function isUniversalEndpoint(token: string): boolean {
  if (isUniversalSpecialToken(token)) return true;
  const pgu = pguLetterLadderValue(token);
  if (pgu !== null) return pgu >= UNIVERSAL_PGU_FLOOR;
  const legacy = legacyFeelingValue(token);
  if (legacy !== null) return legacy >= UNIVERSAL_LEGACY_FLOOR;
  // Bare ladder sortOrder indices sometimes appear (U1 ≈ 41 on DB axis)
  if (/^\d+$/.test(token.trim())) {
    const n = Number(token.trim());
    if (n >= UNIVERSAL_PGU_FLOOR) return true;
  }
  return false;
}

/**
 * True when a proposed feeling/rerate string is at or above the universal floor
 * (legacy 21 = U1 = Q0), including ranges that touch that segment
 * (e.g. G20-U1, U11-13, 20-21, 21.1+, Q0, UQ2).
 */
export function isUniversalFeelingRating(raw: string | null | undefined): boolean {
  if (raw == null) return false;
  const input = String(raw).trim();
  if (!input) return false;

  // Freeform / mixed text: U1–U20, UQ*, Q* tokens
  if (
    /\bU(?:[1-9]|1[0-9]|20)\b/i.test(input) ||
    /\bUQ\d*\b/i.test(input) ||
    /\bQ\d+\b/i.test(input)
  ) {
    return true;
  }
  // Legacy 21 / 21.x+ as a standalone token
  if (/(?:^|[^0-9.])(21(?:\.[0-4])?\+?)(?:$|[^0-9])/.test(input)) {
    return true;
  }

  const parts = parseRatingRange(input, new Set());
  if (parts.some((p) => isUniversalEndpoint(p))) {
    return true;
  }

  // Midpoint of PGU/legacy ranges: exclude if average reaches the universal floor
  if (parts.length === 2) {
    const aPgu = pguLetterLadderValue(parts[0]);
    const bPgu = pguLetterLadderValue(parts[1]);
    if (aPgu !== null && bPgu !== null) {
      return (aPgu + bPgu) / 2 >= UNIVERSAL_PGU_FLOOR;
    }
    const aLeg = legacyFeelingValue(parts[0]);
    const bLeg = legacyFeelingValue(parts[1]);
    if (aLeg !== null && bLeg !== null) {
      return (aLeg + bLeg) / 2 >= UNIVERSAL_LEGACY_FLOOR;
    }
  }

  return false;
}

export const REQUEST_PGU_BANDS = ['P', 'G', 'U'] as const;
export type RequestPguBand = (typeof REQUEST_PGU_BANDS)[number];

/** Proposed request string preferred the same way as rating UI: rerateNum, else requesterFR. */
export function ratingProposalString(
  rerateNum: string | null | undefined,
  requesterFR: string | null | undefined,
): string {
  const primary =
    rerateNum != null && String(rerateNum).trim() !== '' ? rerateNum : requesterFR;
  return primary != null ? String(primary).trim() : '';
}

export function isUniversalRatingProposal(
  rerateNum: string | null | undefined,
  requesterFR: string | null | undefined,
): boolean {
  return isUniversalFeelingRating(ratingProposalString(rerateNum, requesterFR));
}

/**
 * Bucket a rating request the same way zen/list filters do:
 * U = universal proposal, P = lowDiff / planetary request, G = the rest.
 */
export function requestPguBand(
  rerateNum: string | null | undefined,
  requesterFR: string | null | undefined,
  lowDiff?: boolean,
): RequestPguBand {
  if (isUniversalRatingProposal(rerateNum, requesterFR)) return 'U';
  const primary = ratingProposalString(rerateNum, requesterFR);
  if (lowDiff || /^[pP]\d/.test(primary)) return 'P';
  return 'G';
}

/** SQL/list `lowDiff` approximation for an include-set of request bands. */
export function lowDiffFilterForRequestBands(
  includeP: boolean,
  includeG: boolean,
  includeU: boolean,
): 'show' | 'hide' | 'only' {
  if (includeP && !includeG && !includeU) return 'only';
  if (!includeP) return 'hide';
  return 'show';
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
