/** One vote’s number: a point, or the midpoint of two resolved ends. */
export function rangeNumeric(
  low: number | null | undefined,
  high: number | null | undefined,
): number | null {
  const a = typeof low === 'number' && Number.isFinite(low) ? low : null;
  const b = typeof high === 'number' && Number.isFinite(high) ? high : null;
  if (a == null && b == null) return null;
  if (a == null) return b;
  if (b == null) return a;
  return (a + b) / 2;
}

/**
 * Closest item to `target` by `valueOf`. Equal distance keeps the higher value
 * (e.g. 8.5 → 9, 40.5 → 41).
 */
export function snapToNearest<T>(
  items: readonly T[],
  valueOf: (item: T) => number,
  target: number,
): T | null {
  if (items.length === 0 || !Number.isFinite(target)) return null;
  let best = items[0];
  let bestValue = valueOf(best);
  let bestDist = Math.abs(bestValue - target);
  for (let i = 1; i < items.length; i += 1) {
    const item = items[i];
    const value = valueOf(item);
    if (!Number.isFinite(value)) continue;
    const dist = Math.abs(value - target);
    if (dist < bestDist || (dist === bestDist && value > bestValue)) {
      best = item;
      bestValue = value;
      bestDist = dist;
    }
  }
  return best;
}
