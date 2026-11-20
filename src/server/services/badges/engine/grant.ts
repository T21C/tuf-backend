import { labelForTier, type TierLabel } from './curve.js';
import type { EvalResult } from './evaluate.js';
import type { GrantMode } from './params.js';

export type StoredBadge = {
  tier: number;
  credit: number;
  barFrom: number;
  barTo: number;
  barValue: number;
  provingPassIds: number[];
  earnedAt: string | null;
  tierLabel: string | null;
  snapshotIds: number[] | null;
};

export function applyGrant(input: {
  grant: GrantMode;
  labels: readonly TierLabel[];
  previous: StoredBadge | null;
  next: EvalResult;
  replace: boolean;
  now: string;
}): StoredBadge {
  const previous = input.replace ? null : input.previous;
  let tier = input.next.tier;
  let earnedAt = input.next.tier > 0 ? (input.next.earnedAt ?? input.now) : null;
  let provingPassIds = input.next.provingPassIds;
  let snapshotIds = input.next.snapshotIds;

  if (input.grant === 'persistTier' && previous && previous.tier > tier) {
    tier = previous.tier;
    earnedAt = previous.earnedAt;
    provingPassIds = previous.provingPassIds;
  } else if (input.grant === 'persistTier' && previous && previous.tier === tier && previous.tier > 0) {
    earnedAt = previous.earnedAt ?? earnedAt;
  }

  if (input.grant === 'persistSnapshot') {
    snapshotIds = previous?.snapshotIds ?? (input.next.tier > 0 ? input.next.snapshotIds : null);
    if (previous && previous.tier > 0 && tier > 0 && previous.tier === tier) {
      earnedAt = previous.earnedAt ?? earnedAt;
    }
  }

  if (input.grant === 'live' || input.grant === 'resetOnGrowth' || input.grant === 'chase') {
    if (tier <= 0) earnedAt = null;
    else if (previous && previous.tier === tier) earnedAt = previous.earnedAt ?? earnedAt;
  }

  return {
    tier,
    credit: input.next.credit,
    barFrom: input.next.barFrom,
    barTo: input.next.barTo,
    barValue: input.next.barValue,
    provingPassIds,
    earnedAt,
    tierLabel: labelForTier(input.labels, tier),
    snapshotIds,
  };
}
