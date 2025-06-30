import Difficulty from '../models/levels/Difficulty.js';
import { logger } from '../services/LoggerService.js';

// Cache for difficulties to avoid repeated DB queries
let difficultyCache: {
  special: Set<string>;
  map: Map<string, any>;
  nameMap: Map<string, any>;
} | null = null;

// Helper function to get difficulties
export async function getDifficulties(transaction: any) {
  if (!difficultyCache) {
    const difficulties = await Difficulty.findAll({
      transaction,
      order: [['sortOrder', 'ASC']],
    });

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

  const {nameMap} = await getDifficulties(null);
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

// Helper function to filter ratings based on user's top difficulty
export async function filterRatingsByUserTopDiff(ratings: any[], user: any): Promise<any[]> {
  logger.debug(`[RatingUtils] Filtering ratings by user top diff: ${user?.player?.stats?.topDiffId}`);
  if (!user?.player?.stats?.topDiffId) {
    return ratings;
  }

  const {map: difficultyMap, nameMap} = await getDifficulties(null);
  const userTopDiff = difficultyMap.get(user.player.stats.topDiffId.toString());
  
  if (!userTopDiff || userTopDiff.type !== 'PGU') {
    return ratings;
  }

  // Find P16, G20, and U1 difficulties to compare against
  const p16Difficulty = nameMap.get('P16');
  const g20Difficulty = nameMap.get('G20');
  const u1Difficulty = nameMap.get('U1');
  
  if (!p16Difficulty || !g20Difficulty || !u1Difficulty) {
    return ratings;
  }

  logger.debug(`[RatingUtils] Total ratings: ${ratings.length}`);
  const filtered = ratings.filter((rating: any) => {
    // Calculate requestedDiffId for this rating synchronously
    const input = rating.level?.rerateNum || rating.requesterFR;
    if (!input || input.trim() === '') {
      return true; // Allow if no requestedDiffId
    }

    const parts = parseRatingRange(input.trim(), new Set());
    let requestedDiffId: number | null = null;

    // Check for legacy 1-21.3 system using simple regex patterns
    const legacyConvertedParts = parts.map((part: string) => {
      if (/^1?[0-9](\.[0-9]+)?$/.test(part)) {
        return `P5`;
      } else if (/^20(\.[0-9]+)?$/.test(part)) {
        return 'G5';
      } else if (/^21(\.[0-9]+)?$/.test(part)) {
        return 'U5';
      }
      return part; // Return original if not legacy format
    });

    // If it's not a range, just get the difficulty ID
    if (legacyConvertedParts.length === 1) {
      const difficulty = nameMap.get(legacyConvertedParts[0]);
      requestedDiffId = difficulty?.id || null;
    } else {
      // For ranges, find the minimum difficulty by sortOrder
      const difficulties = legacyConvertedParts
        .map((part: string) => nameMap.get(part))
        .filter((diff: any) => diff !== undefined);

      if (difficulties.length > 0) {
        // Find the difficulty with the lowest sortOrder (minimum difficulty)
        const minDifficulty = difficulties.reduce((min: any, current: any) => 
          current.sortOrder < min.sortOrder ? current : min
        );
        requestedDiffId = minDifficulty.id;
      }
    }

    // If requestedDiffId is null or the difficulty doesn't exist in the map, allow it
    if (!requestedDiffId) {
      return true; // Allow if no requestedDiffId
    }

    const requestedDifficulty = difficultyMap.get(requestedDiffId.toString());
    // If the requested difficulty doesn't correspond to anything in the map, allow it
    if (!requestedDifficulty) {
      return true; // Allow if difficulty not found in map
    }
    
    if (requestedDifficulty.type !== 'PGU') {
      return true; // Allow special difficulties
    }

    // If user's top difficulty is U1 or higher (by sortOrder)
    if (userTopDiff.sortOrder >= u1Difficulty.sortOrder) {
      return true; // Allow all ratings
    }
    // If user's top difficulty is P16 or lower (by sortOrder)
    else if (userTopDiff.sortOrder <= p16Difficulty.sortOrder) {
      // Only allow ratings up to their top difficulty
      return requestedDifficulty.sortOrder <= userTopDiff.sortOrder;
    } else {
      // For users between P17 and G20, only allow P and G ratings up to G20
      if (requestedDifficulty.name.startsWith('P') || requestedDifficulty.name.startsWith('G')) {
        return requestedDifficulty.sortOrder <= g20Difficulty.sortOrder;
      }
      return false; // Block U difficulties for P17-G20 users
    }
  });
  
  logger.debug(`[RatingUtils] Filtered ratings: ${filtered.length}, ${ratings.length}`);
  return filtered;
}
