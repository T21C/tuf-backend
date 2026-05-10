import type User from '@/models/auth/User.js';

function subscriptionPeriodActive(user: User): boolean {
  const raw = user.tufStellarSubscriptionExpiresAt;
  if (raw == null) return false;
  const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isFinite(t) && t > Date.now();
}

/**
 * Persisted billing lifecycle (`users.tufStellarBillingLifecycleState`).
 * Updates go through {@link transitionBillingLifecycle} together with subscription facts; guards use {@link getBillingLifecycleState}.
 */
export type BillingLifecycleState =
  | 'inactive'
  | 'active_checkout_pending'
  | 'active_renewing'
  | 'active_cancelling';

const VALID_LIFECYCLE = new Set<string>([
  'inactive',
  'active_checkout_pending',
  'active_renewing',
  'active_cancelling',
]);

export type BillingLifecycleExternalKind = 'recurring' | 'tx' | 'none';

export type BillingLifecycleTransitionEvent =
  | { type: 'webhook_subscription_extended'; externalKind: BillingLifecycleExternalKind }
  | { type: 'webhook_subscription_cancelled' }
  /** Xsolla `cancel_subscription` / API status `canceled` — recurring subscription ended, not merely non-renewing. */
  | { type: 'webhook_subscription_terminated' }
  | { type: 'webhook_subscription_revoked' }
  | { type: 'user_cancel_committed' }
  | { type: 'user_resubscribe_committed' }
  | { type: 'facts_subscription_lapsed' };

export function classifyExternalKind(externalId: string | null | undefined): BillingLifecycleExternalKind {
  if (externalId == null || externalId === '') return 'none';
  const s = String(externalId);
  if (s.startsWith('tx:')) return 'tx';
  return 'recurring';
}

/**
 * Pure transition table: (stored lifecycle, domain event) → next lifecycle.
 */
export function transitionBillingLifecycle(
  from: BillingLifecycleState,
  event: BillingLifecycleTransitionEvent,
): BillingLifecycleState {
  switch (event.type) {
    case 'facts_subscription_lapsed':
    case 'webhook_subscription_revoked':
    case 'webhook_subscription_terminated':
      return 'inactive';

    case 'webhook_subscription_cancelled':
      if (from === 'inactive') return 'inactive';
      return 'active_cancelling';

    case 'user_cancel_committed':
      if (from === 'active_renewing') return 'active_cancelling';
      if (from === 'active_cancelling') return 'active_cancelling';
      return from;

    case 'user_resubscribe_committed':
      if (from === 'active_cancelling') return 'active_renewing';
      return from;

    case 'webhook_subscription_extended': {
      if (event.externalKind === 'recurring') return 'active_renewing';
      if (event.externalKind === 'tx') return 'active_checkout_pending';
      if (from === 'active_cancelling') return 'active_renewing';
      if (from === 'active_renewing') return 'active_renewing';
      if (from === 'active_checkout_pending') return 'active_checkout_pending';
      if (from === 'inactive') return 'active_checkout_pending';
      return from;
    }
    default:
      return from;
  }
}

/** Read persisted lifecycle; invalid DB values are treated as bugs. */
export function getBillingLifecycleState(user: User): BillingLifecycleState {
  const raw = user.tufStellarBillingLifecycleState;
  if (VALID_LIFECYCLE.has(String(raw))) {
    return raw as BillingLifecycleState;
  }
  throw new Error(`Invalid tufStellarBillingLifecycleState: ${String(raw)}`);
}

/**
 * When the paid period has ended but lifecycle was not yet moved to `inactive` (e.g. missed webhook),
 * align the column. Does not infer state from facts while the period is still active.
 */
export async function reconcileBillingLifecycleIfExpired(user: User): Promise<boolean> {
  if (subscriptionPeriodActive(user)) return false;
  if (user.tufStellarBillingLifecycleState === 'inactive') return false;
  await user.update({ tufStellarBillingLifecycleState: 'inactive' });
  return true;
}

function externalId(user: User): string | null {
  const v = user.tufStellarSubscriptionExternalId;
  if (v == null || v === '') return null;
  return String(v);
}

/** Xsolla recurring subscription id (not a transient `tx:` marker). */
export function hasRecurringSubscriptionId(user: User): boolean {
  const ext = externalId(user);
  return ext != null && !ext.startsWith('tx:');
}

export interface BillingAllowedActions {
  /** @deprecated Use purchaseSubscription — kept for older clients */
  checkout: boolean;
  purchaseGift: boolean;
  purchaseSubscription: boolean;
  cancel: boolean;
  resubscribe: boolean;
}

export function checkGiftCheckoutTransition(user: User): BillingGuardResult {
  if (user.status === 'banned' || user.status === 'suspended') {
    return {
      ok: false,
      status: 403,
      code: 'BILLING_ACCOUNT_BLOCKED',
      message: 'Billing actions are not available for this account status.',
    };
  }
  return { ok: true };
}

/** Recurring subscription Pay Station checkout (distinct from one-time gift time). */
export function checkSubscriptionCheckoutTransition(user: User): BillingGuardResult {
  const lifecycle = getBillingLifecycleState(user);
  if (lifecycle === 'inactive') return { ok: true };
  if (lifecycle === 'active_cancelling') {
    return {
      ok: false,
      status: 409,
      code: 'USE_RESUBSCRIBE',
      message: 'Subscription is set to end; use Resubscribe to keep billing, not a new checkout.',
    };
  }
  return {
    ok: false,
    status: 409,
    code: 'SUBSCRIPTION_ALREADY_ACTIVE',
    message: 'You already have an active subscription. Refresh the billing page.',
  };
}

export function getBillingAllowedActions(user: User): BillingAllowedActions {
  const lifecycle = getBillingLifecycleState(user);
  const giftOk = checkGiftCheckoutTransition(user).ok;
  const subOk = checkSubscriptionCheckoutTransition(user).ok;
  return {
    checkout: subOk,
    purchaseGift: giftOk,
    purchaseSubscription: subOk,
    cancel: lifecycle === 'active_renewing' && hasRecurringSubscriptionId(user),
    resubscribe: lifecycle === 'active_cancelling' && hasRecurringSubscriptionId(user),
  };
}

export type BillingGuardDeny = { ok: false; status: number; code: string; message: string };
export type BillingGuardAllow = { ok: true };
export type BillingGuardResult = BillingGuardAllow | BillingGuardDeny;

/** @alias {@link checkSubscriptionCheckoutTransition} */
export function checkCheckoutTransition(user: User): BillingGuardResult {
  return checkSubscriptionCheckoutTransition(user);
}

export function checkCancelTransition(user: User): BillingGuardResult | { ok: true; idempotent: true } {
  const lifecycle = getBillingLifecycleState(user);
  if (lifecycle === 'inactive') {
    return { ok: false, status: 400, code: 'NO_ACTIVE_SUBSCRIPTION', message: 'No active subscription to cancel' };
  }
  if (lifecycle === 'active_checkout_pending') {
    return {
      ok: false,
      status: 400,
      code: 'SUBSCRIPTION_NOT_READY',
      message: 'Subscription is still activating; try again in a moment.',
    };
  }
  if (lifecycle === 'active_cancelling') {
    return { ok: true, idempotent: true };
  }
  if (!hasRecurringSubscriptionId(user)) {
    return {
      ok: false,
      status: 400,
      code: 'NO_RECURRING_SUBSCRIPTION',
      message: 'No recurring subscription id yet; wait for activation or refresh.',
    };
  }
  return { ok: true };
}

export function checkResubscribeTransition(user: User): BillingGuardResult {
  const lifecycle = getBillingLifecycleState(user);
  if (lifecycle === 'active_cancelling') {
    if (!hasRecurringSubscriptionId(user)) {
      return {
        ok: false,
        status: 400,
        code: 'NO_ACTIVE_SUBSCRIPTION',
        message: 'No recurring subscription found to resume',
      };
    }
    return { ok: true };
  }
  if (lifecycle === 'inactive') {
    return {
      ok: false,
      status: 400,
      code: 'SUBSCRIPTION_EXPIRED',
      message: 'Subscription has ended; start a new checkout instead',
    };
  }
  return {
    ok: false,
    status: 400,
    code: 'NOT_CANCELLING',
    message: 'Subscription is not pending cancellation',
  };
}
