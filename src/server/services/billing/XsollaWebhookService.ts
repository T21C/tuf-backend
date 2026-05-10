import crypto from 'crypto';
import type { CreationAttributes } from 'sequelize';
import BillingEvent from '@/models/billing/BillingEvent.js';
import User from '@/models/auth/User.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { isTufStellarSubscriptionActive } from '@/misc/utils/subscriptions/tufStellarSubscription.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {
  classifyExternalKind,
  getBillingLifecycleState,
  transitionBillingLifecycle,
} from '@/misc/utils/subscriptions/billingLifecycleTransition.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import { XsollaApiClient, XsollaApiError } from '@/server/services/billing/XsollaApiClient.js';
import {
  extractTufStellarPlanExternalIdFromXsollaPayload,
  inferGiftMonthsFromXsollaPayload,
  isTufStellarMonths,
  monthsFromTufStellarPlanExternalId,
} from '@/server/services/billing/tufStellarProductCatalog.js';
import { syncXsollaNextChargeToAccessExpiry } from '@/server/services/billing/tufStellarXsollaBillingSync.js';
import { loadOrCreateUserTufStellarBilling } from '@/server/services/billing/userTufStellarBillingSupport.js';
import UserTufStellarBilling from '@/models/billing/UserTufStellarBilling.js';
import {
  appendGiftSegment,
  appendSubscriptionSegment,
  clampUserSegmentsToEndDate,
  deleteAllSegmentsForUser,
  mergeMaterializedExpiryWithWebhookNextCharge,
  recomputeMaterializedExpiry,
} from '@/server/services/billing/tufStellarEntitlementSegments.js';

const BENEFICIARY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Persisted on `billing_events.beneficiary_user_id` for gift IPNs (custom_parameters). */
function beneficiaryUserIdFromWebhookBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const settings = b.settings as Record<string, unknown> | undefined;
  const cp =
    (b.custom_parameters as Record<string, unknown> | undefined) ??
    (b.customParameters as Record<string, unknown> | undefined) ??
    (settings?.custom_parameters as Record<string, unknown> | undefined);
  if (!cp || typeof cp !== 'object') return null;
  const bid = cp.tuf_beneficiary_user_id ?? cp.tufBeneficiaryUserId;
  if (bid == null || bid === '') return null;
  const s = String(bid).trim().toLowerCase();
  return BENEFICIARY_UUID_RE.test(s) ? s : null;
}

/**
 * Subscription payload on payment IPNs uses `purchase.subscription`; dedicated subscription webhooks use top-level
 * `subscription` (see Xsolla `create_subscription` / `update_subscription`).
 */
function xsollaSubscriptionSlice(payload: any): Record<string, unknown> | null {
  const s =
    payload?.purchase?.subscription ??
    payload?.subscription ??
    payload?.notification?.subscription;
  return s != null && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : null;
}

export type XsollaNotificationType =
  | 'user_validation'
  | 'user_search'
  | 'payment'
  | 'refund'
  | 'partial_refund'
  | 'ps_declined'
  | 'afs_reject'
  | 'afs_black_list'
  | 'dispute'
  | 'order_paid'
  | 'order_canceled'
  | 'create_subscription'
  | 'update_subscription'
  | 'cancel_subscription'
  | 'non_renewal_subscription'
  | string;

export class XsollaWebhookService {
  static PROVIDER = 'xsolla';

  static computeSignature(rawBody: Buffer, secret: string): string {
    const h = crypto.createHash('sha1');
    h.update(rawBody);
    h.update(secret, 'utf8');
    return h.digest('hex').toLowerCase();
  }

  static verifySignature(rawBody: Buffer, secret: string, authorizationHeader: string | undefined | null): boolean {
    if (!authorizationHeader) return false;
    const m = authorizationHeader.match(/^Signature\s+([0-9a-fA-F]+)\s*$/);
    if (!m) return false;
    const received = m[1].toLowerCase();
    const computed = this.computeSignature(rawBody, secret);
    if (received.length !== computed.length) return false;
    return crypto.timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(computed, 'hex'));
  }

  static sha256Hex(rawBody: Buffer): string {
    return crypto.createHash('sha256').update(rawBody).digest('hex').toLowerCase();
  }

  static deriveIdempotencyKey(notificationType: XsollaNotificationType, payload: any, rawBodySha256: string): string {
    const txId = payload?.transaction?.id ?? payload?.billing?.transaction?.id;
    if (txId != null && txId !== '') return `tx:${String(txId)}`;

    const subSlice = xsollaSubscriptionSlice(payload);
    const subId = subSlice?.subscription_id ?? subSlice?.subscriptionId;
    if (subSlice != null && subId != null && subId !== '') {
      const nextCharge = subSlice.date_next_charge ?? subSlice.dateNextCharge;
      const created = subSlice.date_create ?? subSlice.dateCreate;
      const t = nextCharge || created || '';
      return `sub:${String(subId)}:${notificationType}:${String(t)}`;
    }

    const orderId = payload?.order?.id ?? payload?.purchase?.order?.id;
    if (orderId != null && orderId !== '') return `order:${String(orderId)}:${notificationType}`;

    return `body:${rawBodySha256}`;
  }

  static extractXsollaFields(payload: any): {
    userId: string | null;
    xsollaTransactionId: number | null;
    xsollaSubscriptionId: number | null;
    externalId: string | null;
  } {
    const userId = normalizeXsollaUserIdFromPayload(payload);
    const txSlice = payload?.transaction ?? payload?.billing?.transaction;
    const xsollaTransactionId =
      txSlice?.id != null && txSlice.id !== ''
        ? Number(txSlice.id)
        : null;
    const subSlice = xsollaSubscriptionSlice(payload);
    const rawSubId = subSlice?.subscription_id ?? subSlice?.subscriptionId;
    const subNum =
      rawSubId != null && String(rawSubId).trim() !== '' ? Number(rawSubId) : Number.NaN;
    const extRaw = txSlice?.external_id ?? txSlice?.externalId;
    const externalId = extRaw != null && extRaw !== '' ? String(extRaw) : null;
    return {
      userId,
      xsollaTransactionId: Number.isFinite(xsollaTransactionId) ? xsollaTransactionId : null,
      xsollaSubscriptionId: Number.isFinite(subNum) ? subNum : null,
      externalId,
    };
  }

  /**
   * Subscription entitlement segments are keyed to **payment** transactions only, so lifecycle webhooks
   * (`create_subscription`, subscription-only `update_subscription`, etc.) do not double-append the same term.
   */
  static resolvePaymentTransactionId(payload: any, event: BillingEvent): number | null {
    const fromEvent = event.xsollaTransactionId;
    if (fromEvent != null && Number.isFinite(Number(fromEvent))) {
      return Number(fromEvent);
    }
    const raw = payload?.transaction?.id ?? payload?.billing?.transaction?.id;
    if (raw != null && raw !== '') {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  static async recordIfNew(params: {
    notificationType: XsollaNotificationType;
    body: any;
  }): Promise<BillingEvent | null> {
    const normalized = Buffer.from(JSON.stringify(params.body), 'utf8');
    const rawBodySha256 = this.sha256Hex(normalized);
    const idempotencyKey = this.deriveIdempotencyKey(params.notificationType, params.body, rawBodySha256);
    const extracted = this.extractXsollaFields(params.body);
    const beneficiaryUserId = beneficiaryUserIdFromWebhookBody(params.body);

    const createAttrs: CreationAttributes<BillingEvent> = {
      provider: this.PROVIDER,
      eventType: params.notificationType,
      idempotencyKey,
      status: 'received',
      rawBody: normalized.toString('utf8'),
      rawBodySha256,
      userId: extracted.userId,
      beneficiaryUserId,
      xsollaTransactionId: extracted.xsollaTransactionId,
      xsollaSubscriptionId: extracted.xsollaSubscriptionId,
      externalId: extracted.externalId,
      processedAt: null,
      failedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date(),
    };

    try {
      return await BillingEvent.create(createAttrs);
    } catch (e: any) {
      const name = e?.name || '';
      const msg = String(e?.message || '');
      if (name === 'SequelizeUniqueConstraintError' || msg.includes('uniq_billing_events_provider_idempotency')) {
        return null;
      }
      throw e;
    }
  }

  static async markProcessed(eventId: number): Promise<void> {
    await BillingEvent.update(
      { status: 'processed', processedAt: new Date(), failedAt: null, errorCode: null, errorMessage: null },
      { where: { id: eventId } },
    );
  }

  static async markFailed(eventId: number, code: string, message: string): Promise<void> {
    await BillingEvent.update(
      { status: 'failed', failedAt: new Date(), errorCode: code, errorMessage: message?.slice(0, 512) ?? null },
      { where: { id: eventId } },
    );
  }

  static async processEvent(event: BillingEvent): Promise<void> {
    try {
      const payload = parseRawBody(event.rawBody);
      const userId =
        normalizeXsollaUserIdFromPayload(payload) ??
        coerceWebhookUserUuid(event.userId);

      switch (event.eventType) {
        case 'payment':
        case 'order_paid': {
          if (userId) {
            await handlePaymentLikeEvent(userId, event, payload);
          } else {
            logger.warn('[Xsolla] payment/order_paid skipped — could not resolve purchaser user id', {
              eventId: event.id,
              storedUserId: event.userId,
            });
          }
          break;
        }
        case 'create_subscription': {
          if (userId) await applyRecurringSubscriptionPatch(userId, event, payload);
          break;
        }
        case 'update_subscription': {
          if (!userId) break;
          const st = extractSubscriptionStatus(payload);
          if (st === 'canceled') {
            await applySubscriptionFullyTerminated(userId, event, payload);
          } else if (st === 'non_renewing') {
            await applySubscriptionNonRenewing(userId, event, payload);
          } else {
            await applyRecurringSubscriptionPatch(userId, event, payload);
          }
          break;
        }
        case 'non_renewal_subscription': {
          if (userId) await applySubscriptionNonRenewing(userId, event, payload);
          break;
        }
        case 'cancel_subscription': {
          if (userId) await applySubscriptionFullyTerminated(userId, event, payload);
          break;
        }
        case 'refund':
        case 'partial_refund':
        case 'order_canceled': {
          if (userId) await applySubscriptionRevoke(userId, event);
          break;
        }
        default:
          break;
      }

      await this.markProcessed(event.id);
    } catch (e) {
      logger.error('[Xsolla] Failed to process billing event', { eventId: event.id, err: e });
      await this.markFailed(event.id, 'PROCESSING_ERROR', e instanceof Error ? e.message : 'Failed to process billing event');
      throw e;
    }
  }
}

// ---------- helpers ----------

/** Pay Station / Catalog tokens often send `user.id` as `{ value: "uuid" }`; webhooks must not use String(object). */
function unwrapXsollaUserIdValue(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object' && raw !== null && 'value' in raw) {
    return unwrapXsollaUserIdValue((raw as { value: unknown }).value);
  }
  const s = String(raw).trim().toLowerCase();
  return BENEFICIARY_UUID_RE.test(s) ? s : null;
}

function normalizeXsollaUserIdFromPayload(payload: any): string | null {
  /** Catalog `order_paid` often sends payer UUID as `user.external_id` (no `user.id`). */
  const candidates = [
    payload?.user?.id,
    payload?.user?.external_id,
    payload?.user?.externalId,
    payload?.notification?.user?.id,
    payload?.notification?.user?.external_id,
    payload?.notification?.user?.externalId,
    payload?.notification?.user_id,
    payload?.user_id,
  ];
  for (const c of candidates) {
    const id = unwrapXsollaUserIdValue(c);
    if (id) return id;
  }
  return null;
}

function coerceWebhookUserUuid(raw: string | null | undefined): string | null {
  return unwrapXsollaUserIdValue(raw);
}

function parseRawBody(rawBody: string): any {
  try {
    return JSON.parse(rawBody);
  } catch {
    return {};
  }
}

function trimmedString(v: unknown): string | null {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function extractCustomParameters(payload: any): Record<string, unknown> {
  const cp =
    payload?.custom_parameters ??
    payload?.customParameters ??
    payload?.settings?.custom_parameters ??
    payload?.notification?.custom_parameters;
  if (cp && typeof cp === 'object' && !Array.isArray(cp)) return cp as Record<string, unknown>;
  return {};
}

function extractTufGiftMeta(payload: any): { beneficiaryId: string | null; months: number | null } {
  const cp = extractCustomParameters(payload);
  const bid = trimmedString(cp.tuf_beneficiary_user_id ?? cp.tufBeneficiaryUserId);
  const mRaw = cp.tuf_gift_months ?? cp.tufGiftMonths;
  const m = mRaw != null && mRaw !== '' ? Number(mRaw) : NaN;
  return {
    beneficiaryId: bid,
    months: Number.isFinite(m) && isTufStellarMonths(m) ? m : null,
  };
}

function parseDate(input: unknown): Date | null {
  if (input == null || input === '') return null;
  const s = typeof input === 'string' || typeof input === 'number' ? input : String(input);
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** End of paid access for the recurring subscription when Xsolla sends full cancellation (optional clamp). */
function extractSubscriptionDateEnd(payload: any): Date | null {
  const sub = xsollaSubscriptionSlice(payload);
  return parseDate(sub?.date_end ?? sub?.dateEnd);
}

/** Xsolla subscription status on API/webhook payloads: `new` | `active` | `canceled` | `non_renewing` | `freeze`. */
function extractSubscriptionStatus(payload: any): string | null {
  const sub = xsollaSubscriptionSlice(payload);
  const raw = sub?.status;
  if (raw == null || raw === '') return null;
  let s = String(raw).trim().toLowerCase();
  if (s === 'cancelled') s = 'canceled';
  return s;
}

function resolveNextExpiry(payload: any): Date {
  const sub = xsollaSubscriptionSlice(payload);
  const next =
    parseDate(sub?.date_next_charge) ??
    parseDate(sub?.dateNextCharge) ??
    parseDate(sub?.expires_at) ??
    parseDate(sub?.expiresAt) ??
    parseDate(payload?.transaction?.payment_date);
  if (next && next.getTime() > Date.now()) return next;
  const fallback = new Date();
  fallback.setUTCDate(fallback.getUTCDate() + 30);
  return fallback;
}

function resolveExternalSubscriptionId(payload: any, event: BillingEvent): string | null {
  if (event.xsollaSubscriptionId != null) return String(event.xsollaSubscriptionId);
  const subSlice = xsollaSubscriptionSlice(payload);
  const subId = subSlice?.subscription_id ?? subSlice?.subscriptionId;
  if (subId != null && subId !== '') return String(subId);
  if (event.externalId) return event.externalId;
  if (event.xsollaTransactionId != null) return `tx:${event.xsollaTransactionId}`;
  return null;
}

async function clearPurchaserPendingCheckout(purchaser: User): Promise<void> {
  const billing = await loadOrCreateUserTufStellarBilling(purchaser.id);
  await billing.update({
    tufStellarPendingGiftBeneficiaryUserId: null,
    tufStellarPendingGiftMonths: null,
    tufStellarPendingAutoRenew: null,
  });
}

async function applyGiftEntitlement(
  beneficiaryUserId: string,
  months: number,
  purchaser: User,
  event: BillingEvent,
): Promise<void> {
  const beneficiary = await User.findByPk(beneficiaryUserId);
  if (!beneficiary) {
    logger.warn('[Xsolla] Gift entitlement skipped — beneficiary missing', { beneficiaryUserId });
    return;
  }

  const benBilling = await loadOrCreateUserTufStellarBilling(beneficiary.id);
  const { endsAt: newExpiry, inserted } = await appendGiftSegment({
    userId: beneficiary.id,
    months,
    idempotencyKey: `seg:gift:${event.idempotencyKey}`,
    xsollaTransactionId: event.xsollaTransactionId,
    xsollaSubscriptionId: event.xsollaSubscriptionId,
    billingEventId: event.id,
  });

  await clearPurchaserPendingCheckout(purchaser);

  try {
    await CacheInvalidation.invalidateUser(beneficiary.id);
  } catch {
    /* best-effort */
  }

  if (beneficiary.playerId != null) {
    try {
      await ElasticsearchService.getInstance().reindexPlayers([beneficiary.playerId]);
    } catch {
      /* best-effort */
    }
  }

  await beneficiary.reload();
  await benBilling.reload();
  await syncXsollaNextChargeToAccessExpiry(beneficiary, benBilling, 'webhook');

  logger.info('[Xsolla] Gift entitlement applied', {
    beneficiaryUserId,
    months,
    newExpiry,
    purchaserId: purchaser.id,
    segmentInserted: inserted,
  });
}

async function handlePaymentLikeEvent(purchaserUserId: string, event: BillingEvent, payload: any): Promise<void> {
  const purchaser = await User.findByPk(purchaserUserId);
  if (!purchaser) return;

  const purchaserBilling = await loadOrCreateUserTufStellarBilling(purchaser.id);
  const pendingBen = purchaserBilling.tufStellarPendingGiftBeneficiaryUserId;
  const pendingMoRaw = purchaserBilling.tufStellarPendingGiftMonths;
  const pendingMo = pendingMoRaw != null ? Number(pendingMoRaw) : NaN;

  if (
    pendingBen != null &&
    trimmedString(pendingBen) &&
    Number.isFinite(pendingMo) &&
    isTufStellarMonths(pendingMo)
  ) {
    await applyGiftEntitlement(trimmedString(pendingBen)!, pendingMo, purchaser, event);
    return;
  }

  const meta = extractTufGiftMeta(payload);
  if (meta.beneficiaryId && meta.months != null) {
    const ben = await User.findByPk(meta.beneficiaryId);
    if (ben) {
      await applyGiftEntitlement(meta.beneficiaryId, meta.months, purchaser, event);
      return;
    }
  }

  const cpMode = String(extractCustomParameters(payload).tuf_checkout_mode ?? '').toLowerCase();
  const inferred = inferGiftMonthsFromXsollaPayload(payload);
  if (inferred != null && cpMode === 'gift') {
    await applyGiftEntitlement(purchaserUserId, inferred, purchaser, event);
    return;
  }

  await applyRecurringSubscriptionPatch(purchaserUserId, event, payload);
}

async function applyRecurringSubscriptionPatch(userId: string, event: BillingEvent, payload: any): Promise<void> {
  const cp = extractCustomParameters(payload);
  if (String(cp.tuf_checkout_mode ?? '').toLowerCase() === 'gift') {
    return;
  }

  const user = await User.findByPk(userId);
  if (!user) return;

  const billing = await loadOrCreateUserTufStellarBilling(user.id);
  const pendingAutoRenew = billing.tufStellarPendingAutoRenew;

  const nextExpiry = resolveNextExpiry(payload);
  let externalId = resolveExternalSubscriptionId(payload, event);
  let mergedExternal = externalId ?? billing.tufStellarSubscriptionExternalId ?? null;
  const existingExt = billing.tufStellarSubscriptionExternalId;
  if (
    mergedExternal != null &&
    String(mergedExternal).startsWith('tx:') &&
    existingExt != null &&
    String(existingExt) !== '' &&
    !String(existingExt).startsWith('tx:')
  ) {
    mergedExternal = String(existingExt);
  }

  const prevLifecycle = getBillingLifecycleState(billing);
  const kind = classifyExternalKind(mergedExternal);
  const nextLifecycle = transitionBillingLifecycle(prevLifecycle, {
    type: 'webhook_subscription_extended',
    externalKind: kind,
  });

  const extractedPlanId = extractTufStellarPlanExternalIdFromXsollaPayload(payload);
  const nextPlanExternalId = extractedPlanId ?? billing.tufStellarSubscriptionPlanExternalId ?? null;

  const sequelizeInst = UserTufStellarBilling.sequelize!;
  await sequelizeInst.transaction(async (t) => {
    const termMonths = monthsFromTufStellarPlanExternalId(nextPlanExternalId);
    const paymentTxId = XsollaWebhookService.resolvePaymentTransactionId(payload, event);

    if (termMonths != null && isTufStellarMonths(termMonths) && paymentTxId != null) {
      // One segment per charged transaction; idempotency tied to tx id avoids duplicate rows from payment + create_subscription.
      await appendSubscriptionSegment({
        userId: user.id,
        months: termMonths,
        idempotencyKey: `seg:sub:tx:${paymentTxId}`,
        xsollaTransactionId: paymentTxId,
        xsollaSubscriptionId: event.xsollaSubscriptionId,
        billingEventId: event.id,
        transaction: t,
      });
    } else if (termMonths != null && isTufStellarMonths(termMonths)) {
      logger.info('[Xsolla] Subscription segment skipped — no payment transaction id (lifecycle/update only)', {
        userId,
        eventId: event.id,
        eventType: event.eventType,
      });
      await mergeMaterializedExpiryWithWebhookNextCharge(user.id, nextExpiry, t);
    } else {
      logger.warn('[Xsolla] Subscription segment skipped — unknown plan months (Xsolla merge fallback)', {
        userId,
        planExternalId: nextPlanExternalId,
        eventId: event.id,
      });
      await mergeMaterializedExpiryWithWebhookNextCharge(user.id, nextExpiry, t);
    }

    await billing.update(
      {
        tufStellarRecurringPeriodEndAt: nextExpiry,
        tufStellarSubscriptionNominalPeriodEndAt: nextExpiry,
        tufStellarSubscriptionExternalId: mergedExternal,
        tufStellarSubscriptionPlanExternalId: nextPlanExternalId,
        tufStellarSubscriptionCancelledAt: null,
        tufStellarBillingLifecycleState: nextLifecycle,
        tufStellarPendingAutoRenew: null,
      },
      { where: { userId: user.id }, transaction: t },
    );
  });

  try {
    await CacheInvalidation.invalidateUser(user.id);
  } catch {
    /* best-effort */
  }

  const wantsNonRenewingCheckout = pendingAutoRenew === false;
  const subIdForXsolla =
    mergedExternal != null && typeof mergedExternal === 'string' && !mergedExternal.startsWith('tx:')
      ? mergedExternal
      : null;
  if (wantsNonRenewingCheckout && subIdForXsolla) {
    try {
      await XsollaApiClient.cancelUserSubscription(userId, subIdForXsolla);
      logger.info('[Xsolla] Applied subscription non-renew preference via partner API', { userId, subId: subIdForXsolla });
    } catch (e) {
      const msg = e instanceof XsollaApiError ? e.message : e instanceof Error ? e.message : String(e);
      logger.error('[Xsolla] Failed to set non_renewing after subscription checkout', { userId, subId: subIdForXsolla, message: msg });
    }
  }

  await user.reload();
  await billing.reload();
  await syncXsollaNextChargeToAccessExpiry(user, billing, 'webhook');
}

/**
 * Clears recurring subscription linkage after Xsolla fully cancels a subscription (`cancel_subscription` webhook,
 * Publisher Account hard cancel, or API status `canceled`). Safe to call from routes when Xsolla rejects resume (422).
 */
export async function applyXsollaSubscriptionTerminatedState(
  userId: string,
  opts?: { subscriptionDateEnd?: Date | null },
): Promise<void> {
  const user = await User.findByPk(userId);
  if (!user) return;

  const billing = await loadOrCreateUserTufStellarBilling(userId);

  const prevLifecycle = getBillingLifecycleState(billing);
  const nextLifecycle = transitionBillingLifecycle(prevLifecycle, { type: 'webhook_subscription_terminated' });

  const dateEnd = opts?.subscriptionDateEnd ?? null;
  const patch = {
    tufStellarSubscriptionCancelledAt: billing.tufStellarSubscriptionCancelledAt ?? new Date(),
    tufStellarSubscriptionExternalId: null as string | null,
    tufStellarSubscriptionPlanExternalId: null as string | null,
    tufStellarRecurringPeriodEndAt: null as Date | null,
    tufStellarSubscriptionNominalPeriodEndAt: null as Date | null,
    tufStellarXsollaBillingSyncAt: null as Date | null,
    tufStellarBillingLifecycleState: nextLifecycle,
  };

  const wasActive = isTufStellarSubscriptionActive(user, billing);

  const sequelizeInst = UserTufStellarBilling.sequelize!;
  await sequelizeInst.transaction(async (t) => {
    if (dateEnd && Number.isFinite(dateEnd.getTime())) {
      await clampUserSegmentsToEndDate(userId, dateEnd, t);
      await recomputeMaterializedExpiry(userId, t);
    }
    await billing.update(patch, { transaction: t });
  });

  try {
    await CacheInvalidation.invalidateUser(user.id);
  } catch {
    /* best-effort */
  }

  await user.reload();
  await billing.reload();
  if (wasActive && !isTufStellarSubscriptionActive(user, billing) && user.playerId != null) {
    try {
      await ElasticsearchService.getInstance().reindexPlayers([user.playerId]);
    } catch {
      /* best-effort */
    }
  }

  logger.info('[Xsolla] Subscription fully terminated (DB)', {
    userId,
    dateEndIso: dateEnd && Number.isFinite(dateEnd.getTime()) ? dateEnd.toISOString() : null,
  });
}

async function applySubscriptionFullyTerminated(userId: string, event: BillingEvent, payload: any): Promise<void> {
  const user = await User.findByPk(userId);
  if (!user) return;

  const billing = await loadOrCreateUserTufStellarBilling(userId);
  const payloadSubId = resolveExternalSubscriptionId(payload, event);
  const stored = billing.tufStellarSubscriptionExternalId;
  if (
    stored &&
    !String(stored).startsWith('tx:') &&
    payloadSubId &&
    !String(payloadSubId).startsWith('tx:') &&
    String(stored) !== String(payloadSubId)
  ) {
    logger.warn('[Xsolla] cancel_subscription skipped — subscription id mismatch', {
      userId,
      stored,
      payloadSubId,
    });
    return;
  }

  const dateEnd = extractSubscriptionDateEnd(payload);
  await applyXsollaSubscriptionTerminatedState(userId, { subscriptionDateEnd: dateEnd });
}

/** `non_renewal_subscription` — renewal off; subscription id stays valid until period ends (resubscribe still possible). */
async function applySubscriptionNonRenewing(userId: string, event: BillingEvent, payload: any): Promise<void> {
  const user = await User.findByPk(userId);
  if (!user) return;

  const billing = await loadOrCreateUserTufStellarBilling(userId);
  const externalId = resolveExternalSubscriptionId(payload, event);
  const prevLifecycle = getBillingLifecycleState(billing);
  const nextLifecycle = transitionBillingLifecycle(prevLifecycle, { type: 'webhook_subscription_cancelled' });

  await billing.update({
    tufStellarSubscriptionCancelledAt: new Date(),
    tufStellarSubscriptionExternalId: externalId ?? billing.tufStellarSubscriptionExternalId ?? null,
    tufStellarBillingLifecycleState: nextLifecycle,
  });

  try {
    await CacheInvalidation.invalidateUser(user.id);
  } catch {
    /* best-effort */
  }
}

async function applySubscriptionRevoke(userId: string, event: BillingEvent): Promise<void> {
  const user = await User.findByPk(userId);
  if (!user) return;

  const billing = await loadOrCreateUserTufStellarBilling(userId);

  const matchesSubscription =
    event.xsollaSubscriptionId != null &&
    billing.tufStellarSubscriptionExternalId === String(event.xsollaSubscriptionId);
  const matchesTransaction =
    event.xsollaTransactionId != null &&
    billing.tufStellarSubscriptionExternalId === `tx:${event.xsollaTransactionId}`;

  if (!matchesSubscription && !matchesTransaction) return;

  const wasActive = isTufStellarSubscriptionActive(user, billing);
  const prevLifecycle = getBillingLifecycleState(billing);
  const nextLifecycle = transitionBillingLifecycle(prevLifecycle, { type: 'webhook_subscription_revoked' });

  const sequelizeInst = UserTufStellarBilling.sequelize!;
  await sequelizeInst.transaction(async (t) => {
    await deleteAllSegmentsForUser(userId, t);
    await recomputeMaterializedExpiry(userId, t);
    await billing.update(
      {
        tufStellarSubscriptionCancelledAt: new Date(),
        tufStellarSubscriptionExternalId: null,
        tufStellarSubscriptionPlanExternalId: null,
        tufStellarRecurringPeriodEndAt: null,
        tufStellarSubscriptionNominalPeriodEndAt: null,
        tufStellarXsollaBillingSyncAt: null,
        tufStellarBillingLifecycleState: nextLifecycle,
      },
      { transaction: t },
    );
  });

  if (wasActive && user.playerId != null) {
    try {
      await ElasticsearchService.getInstance().reindexPlayers([user.playerId]);
    } catch {
      /* best-effort; DB state is authoritative */
    }
  }

  try {
    await CacheInvalidation.invalidateUser(user.id);
  } catch {
    /* best-effort */
  }
}
