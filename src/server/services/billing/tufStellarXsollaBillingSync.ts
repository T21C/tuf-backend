import type User from '@/models/auth/User.js';
import type UserTufStellarBilling from '@/models/billing/UserTufStellarBilling.js';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  getBillingLifecycleState,
  hasRecurringSubscriptionId,
} from '@/misc/utils/subscriptions/billingLifecycleTransition.js';
import { XsollaApiClient, XsollaApiError } from '@/server/services/billing/XsollaApiClient.js';

const WEBHOOK_SYNC_DEBOUNCE_MS = 90_000;
const LAZY_RECONCILE_MIN_INTERVAL_MS = 5 * 60_000;
/** Align if Xsolla next charge is more than this far *before* total access end (instant comparison). */
const ALIGN_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export type XsollaBillingSyncThrottle = 'webhook' | 'lazy';

function parseExpiryMs(expiresAt: Date | null | undefined): number | null {
  if (expiresAt == null) return null;
  const t = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Postpone Xsolla `date_next_charge` so recurring billing aligns with total access end (`tufStellarSubscriptionExpiresAt`).
 * Best-effort: logs errors; does not throw (safe after webhook DB commits).
 */
export async function syncXsollaNextChargeToAccessExpiry(
  user: User,
  billing: UserTufStellarBilling | null,
  throttle: XsollaBillingSyncThrottle = 'webhook',
): Promise<void> {
  if (!billing) return;

  const accessMs = parseExpiryMs(billing.tufStellarSubscriptionExpiresAt ?? null);
  if (accessMs == null || accessMs <= Date.now()) return;

  const ext = billing.tufStellarSubscriptionExternalId;
  if (ext == null || ext === '' || String(ext).startsWith('tx:')) return;

  try {
    if (getBillingLifecycleState(billing) === 'inactive') return;
  } catch {
    return;
  }

  if (!hasRecurringSubscriptionId(billing)) return;

  const recurringStoredMs = parseExpiryMs(billing.tufStellarRecurringPeriodEndAt ?? null);
  /** Gift / one-time time stacked after the paid period: DB recurring end lags total access — must not debounce away. */
  const stackedAccessBeyondRecurring =
    recurringStoredMs == null || accessMs - recurringStoredMs > ALIGN_TOLERANCE_MS;

  const lastSync = billing.tufStellarXsollaBillingSyncAt;
  const lastMs = lastSync ? new Date(lastSync).getTime() : 0;
  const interval = throttle === 'lazy' ? LAZY_RECONCILE_MIN_INTERVAL_MS : WEBHOOK_SYNC_DEBOUNCE_MS;
  if (!stackedAccessBeyondRecurring && lastMs > 0 && Date.now() - lastMs < interval) return;

  try {
    let nextCharge = await XsollaApiClient.getSubscriptionDateNextCharge(user.id, ext);
    if (!nextCharge) {
      logger.warn('[Xsolla] sync billing: missing date_next_charge', { userId: user.id });
      return;
    }

    let nextMs = nextCharge.getTime();
    const deltaMs = accessMs - nextMs;

    if (deltaMs <= ALIGN_TOLERANCE_MS) {
      await billing.update({
        tufStellarXsollaBillingSyncAt: new Date(),
        tufStellarRecurringPeriodEndAt: nextCharge,
      });
      return;
    }

    const totalDays = Math.ceil(deltaMs / 86_400_000);
    await XsollaApiClient.postponeSubscriptionBillingByDays(user.id, ext, totalDays);

    nextCharge = await XsollaApiClient.getSubscriptionDateNextCharge(user.id, ext);
    nextMs = nextCharge?.getTime() ?? nextMs;

    await billing.update({
      tufStellarXsollaBillingSyncAt: new Date(),
      tufStellarRecurringPeriodEndAt: nextCharge ?? billing.tufStellarRecurringPeriodEndAt ?? null,
    });

    logger.info('[Xsolla] Billing aligned via timeshift', {
      userId: user.id,
      subscriptionId: ext,
      postponedDays: totalDays,
    });
  } catch (e) {
    const msg = e instanceof XsollaApiError ? e.message : e instanceof Error ? e.message : String(e);
    logger.error('[Xsolla] syncXsollaNextChargeToAccessExpiry failed', { userId: user.id, message: msg });
  }
}
