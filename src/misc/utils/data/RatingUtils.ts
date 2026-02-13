import Difficulty from '../../../models/levels/Difficulty.js';

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
