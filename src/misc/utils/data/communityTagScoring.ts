export type CommunityTagScoreKnobs = {
  wilsonZ: number;
  scoreOn: number;
  scoreOff: number;
};

export type CommunityTagWeightKnobs = {
  clearerWeight: number;
  defaultWeight: number;
};

/**
 * Wilson score lower bound for a binomial proportion.
 * With no downvotes (p=1) this equals `n / (n + z²)`, matching the old apply-only helper.
 */
export function wilsonLowerBound(upWeight: number, totalWeight: number, wilsonZ: number): number {
  if (!(totalWeight > 0) || !(wilsonZ > 0) || !(upWeight >= 0)) return 0;
  const p = Math.min(1, Math.max(0, upWeight / totalWeight));
  const z2 = wilsonZ * wilsonZ;
  const n = totalWeight;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z2 === 0 ? 0 : wilsonZ * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (center - margin) / denom);
}

/** Apply-only Wilson (all weight is upvotes). */
export function wilsonScore(weightSum: number, wilsonZ: number): number {
  return wilsonLowerBound(weightSum, weightSum, wilsonZ);
}

export function voteWeightForClearer(
  isClearer: boolean,
  knobs: CommunityTagWeightKnobs,
): number {
  return isClearer ? knobs.clearerWeight : knobs.defaultWeight;
}

export function shouldKeepCommunityAssignment(opts: {
  assigned: boolean;
  pinned: boolean;
  score: number;
  knobs: CommunityTagScoreKnobs;
}): boolean {
  if (opts.pinned) return true;
  if (opts.assigned) return opts.score >= opts.knobs.scoreOff;
  return opts.score >= opts.knobs.scoreOn;
}

/** Whether rematerialize may delete an existing unpinned community assignment. */
export function shouldDestroyCommunityAssignment(opts: {
  preserveAssignments: boolean;
  chartCleared: boolean;
  bandOk: boolean;
  keep: boolean;
}): boolean {
  if (opts.preserveAssignments) return false;
  if (!opts.chartCleared || !opts.bandOk) return true;
  return !opts.keep;
}

export type CardSelectableTag = {
  id: number;
  isCommunity?: boolean | null;
  pinned?: boolean | null;
  score?: number | null;
  sortOrder?: number | null;
};

function compareScoreThenSortOrder(a: CardSelectableTag, b: CardSelectableTag): number {
  const scoreA = typeof a.score === 'number' && Number.isFinite(a.score) ? a.score : -1;
  const scoreB = typeof b.score === 'number' && Number.isFinite(b.score) ? b.score : -1;
  if (scoreA !== scoreB) return scoreB - scoreA;
  const sortA = a.sortOrder ?? 0;
  const sortB = b.sortOrder ?? 0;
  if (sortA !== sortB) return sortA - sortB;
  return a.id - b.id;
}

/**
 * Card row: all non-community tags, all pinned community tags, and the top
 * `cap` unpinned community tags by score then sortOrder. Community visibles
 * are ordered by score then sortOrder; non-community keep caller order.
 */
export function selectLevelCardDisplayTags<T extends CardSelectableTag>(
  tags: T[],
  cap: number,
): T[] {
  const nonCommunity: T[] = [];
  const pinnedCommunity: T[] = [];
  const unpinnedCommunity: T[] = [];

  for (const tag of tags) {
    if (!tag.isCommunity) {
      nonCommunity.push(tag);
      continue;
    }
    if (tag.pinned) {
      pinnedCommunity.push(tag);
    } else {
      unpinnedCommunity.push(tag);
    }
  }

  unpinnedCommunity.sort(compareScoreThenSortOrder);
  const limitedUnpinned = unpinnedCommunity.slice(0, Math.max(0, cap));
  const communityVisible = [...pinnedCommunity, ...limitedUnpinned].sort(compareScoreThenSortOrder);
  return [...nonCommunity, ...communityVisible];
}
