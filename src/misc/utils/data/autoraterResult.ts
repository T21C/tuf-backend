const tierPattern = '(?:[PGU](?:[1-9]|1[0-9]|20)|Impossible|Censored)';
const tier = new RegExp(`^${tierPattern}$`);
const average = new RegExp(`^(${tierPattern})(?: (low|mid|high))?$`);
const display = new RegExp(`^(${tierPattern})(?: (?:low|mid|high))? \\((${tierPattern}), (${tierPattern}), (${tierPattern}), (${tierPattern})\\)$`);

export interface AutoraterRatingResult {
  tufid: number;
  rating_result: string;
  avg: string;
  rr: string;
  v2: string;
  v21: string;
  v22: string;
}

/** Reject mismatched charts or partial responses before replacing a saved rating. */
export function validateAutoraterResult(value: unknown, levelId: number): AutoraterRatingResult {
  if (!value || typeof value !== 'object') throw new Error('Invalid AutoRater result');
  const result = value as Record<string, unknown>;
  const labels = [result.rr, result.v2, result.v21, result.v22];
  if (result.tufid !== levelId || typeof result.avg !== 'string' || !average.test(result.avg)
    || !labels.every(label => typeof label === 'string' && tier.test(label))
    || typeof result.rating_result !== 'string' || result.rating_result.length > 255
    || result.rating_result !== `${result.avg} (${labels.join(', ')})`
    || !display.test(result.rating_result)) {
    throw new Error('Invalid AutoRater result');
  }
  return value as AutoraterRatingResult;
}

/** Count the machine's AVG as one vote; the four model labels are display details. */
export function ratingForAverage(rating: string, userId: string, autoraterId?: string): string {
  if (!autoraterId || userId !== autoraterId) return rating;
  return display.exec(rating)?.[1] ?? rating;
}

/** RR, V2, V2.1, and V2.2 labels from a stored V2 display string. */
export function autoraterModelLabels(rating: string | null | undefined): string[] | null {
  const match = display.exec(String(rating ?? '').trim());
  if (!match) return null;
  return [match[2], match[3], match[4], match[5]];
}
