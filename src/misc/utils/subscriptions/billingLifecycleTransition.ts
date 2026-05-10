import type User from '@/models/auth/User.js';
import type UserTufStellarBilling from '@/models/billing/UserTufStellarBilling.js';

export type BillingRow = UserTufStellarBilling | null;

export interface BillingAllowedActions {
  /** Catalog one-time checkout: self or chosen recipient. */
  purchaseOneTime: boolean;
}

export function checkPurchaseCheckoutTransition(user: User): BillingGuardResult {
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

export function getBillingAllowedActions(user: User, _billing: BillingRow): BillingAllowedActions {
  void _billing;
  return {
    purchaseOneTime: checkPurchaseCheckoutTransition(user).ok,
  };
}

export type BillingGuardDeny = { ok: false; status: number; code: string; message: string };
export type BillingGuardAllow = { ok: true };
export type BillingGuardResult = BillingGuardAllow | BillingGuardDeny;
