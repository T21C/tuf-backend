export type CommunityTagScoreKnobs = {
  wilsonZ: number;
  scoreOn: number;
  scoreOff: number;
};

export type CommunityTagWeightKnobs = {
  clearerWeight: number;
  defaultWeight: number;
};

export function wilsonScore(weightSum: number, wilsonZ: number): number {
  if (!(weightSum > 0) || !(wilsonZ > 0)) return 0;
  const z2 = wilsonZ * wilsonZ;
  return weightSum / (weightSum + z2);
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
