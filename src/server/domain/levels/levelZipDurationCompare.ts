/**
 * Compare two duration arrays with a tolerance of ~0.5ms.
 * Returns mismatch information including indices and ranges.
 */
export interface DurationMismatchResult {
  matches: boolean;
  mismatches: number[];
  ranges: Array<{ start: number; end: number }>;
}

export function compareDurations(originalDurations: number[], newDurations: number[]): DurationMismatchResult {
  const result: DurationMismatchResult = {
    matches: true,
    mismatches: [],
    ranges: [],
  };

  if (originalDurations.length !== newDurations.length) {
    result.matches = false;
    return result;
  }

  const tolerance = 0.5; // ms

  for (let i = 0; i < originalDurations.length; i++) {
    const diff = Math.abs(originalDurations[i] - newDurations[i]);
    if (diff > tolerance) {
      result.matches = false;
      result.mismatches.push(i);
    }
  }

  if (result.mismatches.length > 0) {
    let rangeStart = result.mismatches[0];
    let rangeEnd = result.mismatches[0];

    for (let i = 1; i < result.mismatches.length; i++) {
      if (result.mismatches[i] === rangeEnd + 1) {
        rangeEnd = result.mismatches[i];
      } else {
        result.ranges.push({ start: rangeStart, end: rangeEnd });
        rangeStart = result.mismatches[i];
        rangeEnd = result.mismatches[i];
      }
    }
    result.ranges.push({ start: rangeStart, end: rangeEnd });
  }

  return result;
}

/** Format duration mismatch message for user feedback */
export function formatDurationMismatchMessage(mismatchResult: DurationMismatchResult): string {
  if (mismatchResult.matches) {
    return '';
  }

  const { mismatches, ranges } = mismatchResult;

  if (mismatches.length < 5 && ranges.length === mismatches.length) {
    const tileNumbers = mismatches.map((index) => index + 1).join(', ');
    return `Tiles ${tileNumbers} have different timing than original`;
  }

  const displayRanges = ranges.slice(0, 3);
  const remainingRanges = ranges.length - 3;
  const remainingMismatches =
    remainingRanges > 0 ? ranges.slice(3).reduce((sum, range) => sum + (range.end - range.start + 1), 0) : 0;

  const rangeStrings = displayRanges.map((range) => {
    if (range.start === range.end) {
      return `Tile ${range.start + 1}`;
    }
    return `Tiles ${range.start + 1}-${range.end + 1}`;
  });

  let message = rangeStrings.join(', ');

  if (remainingRanges > 0) {
    message += `, and ${remainingMismatches} more tile${remainingMismatches !== 1 ? 's' : ''}`;
  }

  return `${message} have different timing than original`;
}
