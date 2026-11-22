export type ChaseProgress = {
  tier: number;
  credit: number;
  from: number;
  to: number;
};

export function chaseProgress(
  charts: { id: number; diffName: string }[],
  clearedIds: Iterable<number>,
  excludeNames: readonly string[],
  frozenIds?: ReadonlySet<number> | null,
): ChaseProgress {
  const skip = new Set(excludeNames.filter((name) => name.length > 0));
  const cleared = clearedIds instanceof Set ? clearedIds : new Set(clearedIds);
  let minimum: number | null = null;
  let next: number | null = null;
  for (const chart of charts) {
    if (frozenIds && !frozenIds.has(chart.id)) continue;
    if (skip.has(chart.diffName)) continue;
    if (minimum == null || chart.id < minimum) minimum = chart.id;
    if (!cleared.has(chart.id) && (next == null || chart.id < next)) next = chart.id;
  }
  const tier = minimum != null && cleared.has(minimum) ? 1 : 0;
  return {
    tier,
    credit: next == null ? tier : next,
    from: 0,
    to: 1,
  };
}
