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

export function calculateAverageRating(ratings: RatingsObject): string | null {
    if (!ratings || Object.keys(ratings).length === 0) return null;

    // Count occurrences of special ratings
    const specialRatingCounts: SpecialRatingCounts = {};
    const numericRatings: number[] = [];

    // Process all ratings
    Object.values(ratings).forEach(([rating]) => {
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