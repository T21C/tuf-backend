type PguRatingMap = { [key: string]: number };
type RatingArray = [string, string]; // [rating, comment]
type RatingsObject = { [username: string]: RatingArray };
type SpecialRatingCounts = { [rating: string]: number };

// Rating parser utilities
const pguRatingMap: PguRatingMap = {
    // P ratings: 100 series
    ...Object.fromEntries([...Array(20)].map((_, i) => [`P${i + 1}`, 0 + i + 1])),
    // G ratings: 200 series
    ...Object.fromEntries([...Array(20)].map((_, i) => [`G${i + 1}`, 20 + i + 1])),
    // U ratings: 300 series
    ...Object.fromEntries([...Array(20)].map((_, i) => [`U${i + 1}`, 40 + i + 1])),
};

const reversePguMap: { [key: number]: string } = Object.fromEntries(
    Object.entries(pguRatingMap).map(([key, value]) => [value, key])
);

// Special ratings that can be averaged if they appear 4 or more times
const specialRatings: Set<string> = new Set([
    'Qq', 'Q1+', 'Q2', 'Q2+', 'Q3', 'Q3+', 'Q4', 
    'Bus', 'Grande', 'MA', 'MP', '-21', '-2', '0'
]);

export function parseRating(rating: string | null): number | string | null {
    if (!rating) return null;
    
    // Convert to uppercase for consistency
    const upperRating = rating.toUpperCase();
    
    // Check if it's a PGU rating
    if (pguRatingMap[upperRating]) {
        return pguRatingMap[upperRating];
    }
    
    // Check if it's a special rating
    if (specialRatings.has(rating)) {
        return rating;
    }
    
    return null;
}

export function formatRating(numericRating: number): string | null {
    return reversePguMap[numericRating] || null;
}

export function calculateAverageRating(ratings: any[]): string | null {
    if (!ratings || ratings.length === 0) return null;

    // Count occurrences of special ratings
    const specialRatingCounts: SpecialRatingCounts = {};
    const numericRatings: number[] = [];

    // Process all ratings
    ratings.forEach(({ rating }) => {
        if (!rating) return;

        const parsed = parseRating(rating);
        if (typeof parsed === 'number') {
            numericRatings.push(parsed);
        } else if (parsed && specialRatings.has(rating)) {
            specialRatingCounts[rating] = (specialRatingCounts[rating] || 0) + 1;
        }
    });

    // Check for special ratings with 4+ occurrences
    for (const [rating, count] of Object.entries(specialRatingCounts)) {
        if (count >= 4) {
            return rating;
        }
    }
    if (numericRatings.length > 0) {
        const average = numericRatings.reduce((a, b) => a + b, 0) / numericRatings.length;
        return formatRating(Math.round(average));
    }

    return null;
}


export function calculatePguDiffNum(pguDiff: string): number {
    if (!pguDiff) return 0;
  
    const difficultyMap: { [key: string]: number } = {
      "Unranked": 0,
      ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`P${i + 1}`, i + 1])),
      ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`G${i + 1}`, i + 21])),
      ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`U${i + 1}`, i + 41])),
      "QQ": 61,
      "Q2": 62,
      "Q2p": 63,
      "Q3": 64,
      "Q3p": 65,
      "Q4": 66,
      "MP": -22,
      "Grande": 100,
      "Bus": 101,
      "MA": 102,
    };
  
    // Convert the array of entries back to an object
    const diffMap = Object.fromEntries(Object.entries(difficultyMap));
  
    // Try to parse as number first
    const numericValue = Number(pguDiff);
    if (!isNaN(numericValue)) {
      return numericValue;
    }
  
    // Look up in difficulty map
    return diffMap[pguDiff] || 0;
  }


export function calculateBaseScore(value: number): number {
    if (!value || value < 1) return 0;
  
    const scoreMap: { [key: number]: number } = {
      1: 0.1,  2: 0.2,  3: 0.3,  4: 0.4,  5: 0.5,
      6: 0.6,  7: 0.7,  8: 0.8,  9: 0.9,  10: 1,
      11: 2,   12: 3,   13: 5,   14: 10,  15: 15,
      16: 20,  17: 30,  18: 45,  19: 60,  20: 75,
      21: 100, 22: 110, 23: 120, 24: 130, 25: 140,
      26: 150, 27: 160, 28: 170, 29: 180, 30: 190,
      31: 200, 32: 210, 33: 220, 34: 230, 35: 240,
      36: 250, 37: 275, 38: 300, 39: 350, 40: 400,
      41: 500, 42: 600, 43: 700, 44: 850, 45: 1000,
      46: 1300, 47: 1600, 48: 1800, 49: 2000, 50: 2500,
      51: 3000, 52: 4000, 53: 5000, 54: 11000,
      [-21]: 0, [-22]: 0, [-1]: 0.1, [-2]: 0
    };
  
    return scoreMap[value] ?? 0;
  }
  