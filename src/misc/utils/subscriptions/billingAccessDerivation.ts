import type User from '@/models/auth/User.js';
import type { BillingRow } from '@/misc/utils/subscriptions/billingLifecycleTransition.js';
import { hasRecurringSubscriptionId } from '@/misc/utils/subscriptions/billingLifecycleTransition.js';

export interface BillingAccessSegmentInput {
  kind: 'gift' | 'subscription';
  startsAt: Date;
  endsAt: Date;
}

export interface DerivedBillingAccessParts {
  /**
   * Access from gifts / one-time purchases: wall-clock overlap of gift segments with remaining total access.
   */
  giftFundedRemainingMs: number;
  /**
   * Subscription-funded access remaining: overlap of `subscription` segments with `[now, totalExpiry]` when segments
   * exist; otherwise legacy nominal/recurring boundary minus `now` when recurring.
   */
  subscriptionPaidPeriodRemainingMs: number;
  /** @deprecated Use {@link giftFundedRemainingMs}; kept equal for older clients. */
  oneTimeRemainingMs: number;
  recurringPeriodEndsAt: Date | null;
  totalExpiresAt: Date | null;
  /**
   * Latest `endsAt` among subscription segments that still overlap total access after `now`; for UI “through” date
   * when splitting by segments. Null when using legacy nominal split or no subscription overlap.
   */
  subscriptionFundedCoverageEndsAt: Date | null;
}

/** Merge overlapping intervals on the timeline and sum overlap length with [windowStartMs, windowEndMs). */
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

function subscriptionFundedCoverageEndsAtFromSegments(
  segments: BillingAccessSegmentInput[],
  nowMs: number,
  totalMs: number,
): Date | null {
  let maxEnd: number | null = null;
  for (const s of segments) {
    if (s.kind !== 'subscription') continue;
    const start = new Date(s.startsAt).getTime();
    const end = new Date(s.endsAt).getTime();
    if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) continue;
    if (end <= nowMs || start >= totalMs) continue;
    if (maxEnd === null || end > maxEnd) maxEnd = end;
  }
  return maxEnd != null ? new Date(maxEnd) : null;
}

/** Split gift-funded vs subscription-funded access for billing UI (`GET /v3/billing/me`). */
export function deriveBillingAccessParts(
  user: User,
  billing: BillingRow,
  segments: BillingAccessSegmentInput[],
  nowMs: number = Date.now(),
): DerivedBillingAccessParts {
  void user;
  const totalExp = billing?.tufStellarSubscriptionExpiresAt ?? null;
  const totalMs = totalExp ? new Date(totalExp).getTime() : NaN;

  const recurringExp = billing?.tufStellarRecurringPeriodEndAt ?? null;
  const recurringMs = recurringExp ? new Date(recurringExp).getTime() : NaN;

  const nominalExp = billing?.tufStellarSubscriptionNominalPeriodEndAt ?? null;
  const nominalMs = nominalExp ? new Date(nominalExp).getTime() : NaN;

  const hasRecurring = hasRecurringSubscriptionId(billing);

  const splitBoundaryMs =
    hasRecurring && Number.isFinite(nominalMs)
      ? nominalMs
      : hasRecurring && Number.isFinite(recurringMs)
        ? recurringMs
        : NaN;

  if (!Number.isFinite(totalMs) || totalMs <= nowMs) {
    return {
      giftFundedRemainingMs: 0,
      subscriptionPaidPeriodRemainingMs: 0,
      oneTimeRemainingMs: 0,
      recurringPeriodEndsAt: recurringExp,
      totalExpiresAt: totalExp,
      subscriptionFundedCoverageEndsAt: null,
    };
  }

  const giftIntervals = segments
    .filter((s) => s.kind === 'gift')
    .map((s) => ({
      start: new Date(s.startsAt).getTime(),
      end: new Date(s.endsAt).getTime(),
    }));

  const subIntervals = segments
    .filter((s) => s.kind === 'subscription')
    .map((s) => ({
      start: new Date(s.startsAt).getTime(),
      end: new Date(s.endsAt).getTime(),
    }));

  const useSegmentSplit = segments.length > 0;

  let subscriptionPaidPeriodRemainingMs = 0;
  let giftFundedRemainingMs = 0;
  let subscriptionFundedCoverageEndsAt: Date | null = null;

  if (useSegmentSplit) {
    giftFundedRemainingMs = intervalUnionOverlapMs(giftIntervals, nowMs, totalMs);
    if (hasRecurring) {
      subscriptionPaidPeriodRemainingMs = intervalUnionOverlapMs(subIntervals, nowMs, totalMs);
      subscriptionFundedCoverageEndsAt = subscriptionFundedCoverageEndsAtFromSegments(segments, nowMs, totalMs);
    }
  } else {
    subscriptionPaidPeriodRemainingMs =
      hasRecurring && Number.isFinite(splitBoundaryMs) ? Math.max(0, splitBoundaryMs - nowMs) : 0;

    const windowStartMs =
      hasRecurring && Number.isFinite(splitBoundaryMs) ? Math.max(nowMs, splitBoundaryMs) : nowMs;

    if (giftIntervals.length > 0) {
      giftFundedRemainingMs = intervalUnionOverlapMs(giftIntervals, windowStartMs, totalMs);
    } else if (!hasRecurring) {
      giftFundedRemainingMs = Math.max(0, totalMs - nowMs);
    }
  }

  return {
    giftFundedRemainingMs,
    subscriptionPaidPeriodRemainingMs,
    oneTimeRemainingMs: giftFundedRemainingMs,
    recurringPeriodEndsAt: recurringExp,
    totalExpiresAt: totalExp,
    subscriptionFundedCoverageEndsAt,
  };
}
