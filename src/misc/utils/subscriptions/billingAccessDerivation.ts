import type User from '@/models/auth/User.js';
import { hasRecurringSubscriptionId } from '@/misc/utils/subscriptions/billingLifecycleTransition.js';

export interface DerivedBillingAccessParts {
  oneTimeRemainingMs: number;
  recurringPeriodEndsAt: Date | null;
  totalExpiresAt: Date | null;
}

/** Split total access vs recurring period end for billing UI (`GET /v3/billing/me`). */
export function deriveBillingAccessParts(user: User, nowMs: number = Date.now()): DerivedBillingAccessParts {
  const totalExp = user.tufStellarSubscriptionExpiresAt ?? null;
  const totalMs = totalExp ? new Date(totalExp).getTime() : NaN;

  const recurringExp = user.tufStellarRecurringPeriodEndAt ?? null;
  const recurringMs = recurringExp ? new Date(recurringExp).getTime() : NaN;

  const hasRecurring = hasRecurringSubscriptionId(user);

  if (!Number.isFinite(totalMs) || totalMs <= nowMs) {
    return {
      oneTimeRemainingMs: 0,
      recurringPeriodEndsAt: recurringExp,
      totalExpiresAt: totalExp,
    };
  }

  let oneTimeRemainingMs = 0;
  if (hasRecurring && Number.isFinite(recurringMs)) {
    oneTimeRemainingMs = Math.max(0, totalMs - Math.max(nowMs, recurringMs));
  } else if (!hasRecurring) {
    oneTimeRemainingMs = Math.max(0, totalMs - nowMs);
  }

  return {
    oneTimeRemainingMs,
    recurringPeriodEndsAt: recurringExp,
    totalExpiresAt: totalExp,
  };
}
