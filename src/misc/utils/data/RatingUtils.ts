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

  const {special: specialDifficulties, nameMap: difficultyMap} = await getDifficulties(transaction);

  const parts = await parseRatingRange(rating, specialDifficulties);
  // If it's not a range, just normalize the single rating
  if (parts.length === 1) {
    // First check if it's a special difficulty directly
    if (specialDifficulties.has(parts[0])) {
      return {specialRatings: [parts[0]]};
    }

    const match = parts[0].match(/([PGUpgu])(-?\d+)/);
    if (!match || !match[1]) {
      return {specialRatings: []};
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const [_, prefix, num] = match;
    const normalizedRating = prefix.toUpperCase() + num;

    // Check if it's a special difficulty after normalization
    if (specialDifficulties.has(normalizedRating)) {
      return {specialRatings: [normalizedRating]};
    }

    return {
      pguRating: normalizedRating,
      specialRatings: [],
    };
  }

  // Process range
  type RatingInfo = {
    raw: string;
    isSpecial: boolean;
    difficulty?: any;
    sortOrder?: number;
  };

  const ratings = parts
    .map(r => {
      // First check if it's a special rating as is
      if (specialDifficulties.has(r)) {
        const difficulty = difficultyMap.get(r);
        return {
          raw: r,
          isSpecial: true,
          difficulty,
          sortOrder: difficulty?.sortOrder
        } as RatingInfo;
      }

      const match = r.match(/([PGUpgu]*)(-?\d+)/);
      if (!match || !match[1]) {
        return null;
      }
      const prefix = match[1].toUpperCase();
      const num = match[2];
      const normalizedName = `${prefix}${num}`;
      const difficulty = difficultyMap.get(normalizedName);
      return difficulty ? {
        raw: normalizedName,
        isSpecial: false,
        difficulty,
        sortOrder: difficulty.sortOrder
      } as RatingInfo : null;
    })
    .filter((r): r is RatingInfo => r !== null);

  if (ratings.length !== 2) {
    return {specialRatings: []};
  }

  // Collect special ratings
  const specialRatings = ratings.filter(r => r.isSpecial).map(r => r.raw);

  // Find PGU ratings
  const pguRatings = ratings.filter(r => !r.isSpecial && r.difficulty);
  if (pguRatings.length === 0) {
    return {specialRatings};
  }

  if (pguRatings.length === 1) {
    return {
      pguRating: pguRatings[0].raw,
      specialRatings,
    };
  }

  // Average by sortOrder and find closest PGU by sortOrder
  const avgSortOrder =
    pguRatings.reduce((sum, r) => sum + (r.difficulty?.sortOrder ?? 0), 0) / pguRatings.length;

  const pguDifficulties = Array.from(difficultyMap.values())
    .filter(d => d.type === 'PGU')
    .sort(
      (a, b) =>
        Math.abs(a.sortOrder - avgSortOrder) - Math.abs(b.sortOrder - avgSortOrder),
    );
  const closestDifficulty = pguDifficulties[0];

  return {
    pguRating: closestDifficulty?.name,
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
  const pguVotes = new Map<number, number>(); // Map of sortOrder to vote count

  // First pass: Count all votes
  for (const detail of details) {
    if (!detail.rating) continue;

    const {pguRating, specialRatings} = await normalizeRating(
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

    // Process PGU rating if present
    if (pguRating) {
      const difficulty = difficultyMap.get(pguRating);
      if (!difficulty || difficulty.type !== 'PGU') continue;

      const currentCount = pguVotes.get(difficulty.sortOrder) ?? 0;
      pguVotes.set(difficulty.sortOrder, currentCount + 1);
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

  // If no special rating has enough votes, calculate PGU average by sortOrder
  if (pguVotes.size > 0) {
    const totalVotes = Array.from(pguVotes.values()).reduce(
      (sum, count) => sum + count,
      0,
    );

    const weightedAvgSortOrder =
      Array.from(pguVotes.entries()).reduce(
        (sum, [sortOrder, count]) => sum + sortOrder * count,
        0,
      ) / totalVotes;

    const pguDifficulties = Array.from(difficultyMap.values())
      .filter(d => d.type === 'PGU')
      .sort(
        (a, b) =>
          Math.abs(a.sortOrder - weightedAvgSortOrder) -
          Math.abs(b.sortOrder - weightedAvgSortOrder),
      );

    if (pguDifficulties.length > 0) {
      return pguDifficulties[0];
    }
  }


  return null;
}
