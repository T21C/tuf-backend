import type User from '@/models/auth/User.js';
import type UserTufStellarBilling from '@/models/billing/UserTufStellarBilling.js';

export interface BillingAccessSegmentInput {
  kind: 'purchase';
  startsAt: Date;
  endsAt: Date;
}

export interface DerivedBillingAccessParts {
  /** Access window from stacked purchase segments overlapping remaining total access (ms until expiry wall clock). */
  purchaseFundedRemainingMs: number;
  totalExpiresAt: Date | null;
}

/** Merge overlapping intervals and sum overlap length with [windowStartMs, windowEndMs). */
function intervalUnionOverlapMs(
  intervalsMs: { start: number; end: number }[],
  windowStartMs: number,
  windowEndMs: number,
): number {
  if (!Number.isFinite(windowEndMs) || windowEndMs <= windowStartMs) return 0;
  const sorted = intervalsMs
    .filter((x) => Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > x.start)
    .sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (!last || iv.start > last.end) merged.push({ ...iv });
    else last.end = Math.max(last.end, iv.end);
  }
  let sum = 0;
  for (const iv of merged) {
    const lo = Math.max(iv.start, windowStartMs);
    const hi = Math.min(iv.end, windowEndMs);
    if (hi > lo) sum += hi - lo;
  }
  return sum;
}

/** Remaining access from purchase segments before total expiry. */
export function deriveBillingAccessParts(
  user: User,
  billing: UserTufStellarBilling | null,
  segments: BillingAccessSegmentInput[],
  nowMs: number = Date.now(),
): DerivedBillingAccessParts {
  void user;
  const totalExp = billing?.tufStellarSubscriptionExpiresAt ?? null;
  const totalMs = totalExp ? new Date(totalExp).getTime() : NaN;

  if (!Number.isFinite(totalMs) || totalMs <= nowMs) {
    return {
      purchaseFundedRemainingMs: 0,
      totalExpiresAt: totalExp,
    };
  }

  const purchaseIntervals = segments
    .filter((s) => s.kind === 'purchase')
    .map((s) => ({
      start: new Date(s.startsAt).getTime(),
      end: new Date(s.endsAt).getTime(),
    }));

  const purchaseFundedRemainingMs = intervalUnionOverlapMs(purchaseIntervals, nowMs, totalMs);

  return {
    purchaseFundedRemainingMs,
    totalExpiresAt: totalExp,
  };
}
