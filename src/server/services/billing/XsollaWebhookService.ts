import crypto from 'crypto';
import type { CreationAttributes } from 'sequelize';
import BillingEvent from '@/models/billing/BillingEvent.js';
import User from '@/models/auth/User.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { isTufStellarAccessActive } from '@/misc/utils/subscriptions/tufStellarSubscription.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import { inferGiftMonthsFromXsollaPayload, isTufStellarMonths } from '@/server/services/billing/tufStellarProductCatalog.js';
import { loadOrCreateUserTufStellarBilling } from '@/server/services/billing/userTufStellarBillingSupport.js';
import UserTufStellarBilling from '@/models/billing/UserTufStellarBilling.js';
import {
  appendPurchaseSegment,
  revokePurchaseSegmentsByXsollaTransactionId,
} from '@/server/services/billing/tufStellarEntitlementSegments.js';
import { isTufStellarFeatureEnabled } from '@/config/app.config.js';

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
      return `sub:${String(subId)}:${notificationType}:${rawBodySha256}`;
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
        case 'create_subscription':
        case 'update_subscription':
        case 'non_renewal_subscription':
        case 'cancel_subscription': {
          logger.info('[Xsolla] recurring-plan webhook ignored (purchase-only billing)', {
            eventId: event.id,
            eventType: event.eventType,
          });
          break;
        }
        case 'refund':
        case 'partial_refund':
        case 'order_canceled': {
          await applyPurchaseRefundRevoke(event);
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

function unwrapXsollaUserIdValue(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object' && raw !== null && 'value' in raw) {
    return unwrapXsollaUserIdValue((raw as { value: unknown }).value);
  }
  const s = String(raw).trim().toLowerCase();
  return BENEFICIARY_UUID_RE.test(s) ? s : null;
}

function normalizeXsollaUserIdFromPayload(payload: any): string | null {
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

async function clearPurchaserPendingCheckout(purchaser: User): Promise<void> {
  const billing = await loadOrCreateUserTufStellarBilling(purchaser.id);
  await billing.update({
    tufStellarPendingGiftBeneficiaryUserId: null,
    tufStellarPendingGiftMonths: null,
  });
}

async function applyPurchaseEntitlementToBeneficiary(
  beneficiaryUserId: string,
  months: number,
  purchaser: User,
  event: BillingEvent,
): Promise<void> {
  const beneficiary = await User.findByPk(beneficiaryUserId);
  if (!beneficiary) {
    logger.warn('[Xsolla] Purchase entitlement skipped — beneficiary missing', { beneficiaryUserId });
    return;
  }

  const benBilling = await loadOrCreateUserTufStellarBilling(beneficiary.id);
  const { endsAt: newExpiry, inserted } = await appendPurchaseSegment({
    userId: beneficiary.id,
    months,
    idempotencyKey: `seg:purchase:${event.idempotencyKey}`,
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

  logger.info('[Xsolla] Purchase entitlement applied', {
    beneficiaryUserId,
    months,
    newExpiry,
    purchaserId: purchaser.id,
    segmentInserted: inserted,
  });
}

async function handlePaymentLikeEvent(purchaserUserId: string, event: BillingEvent, payload: any): Promise<void> {
  if (!isTufStellarFeatureEnabled()) {
    logger.info('[Xsolla] payment/order_paid skipped — TUF_STELLAR_ENABLED is off', { eventId: event.id });
    return;
  }

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
    await applyPurchaseEntitlementToBeneficiary(trimmedString(pendingBen)!, pendingMo, purchaser, event);
    return;
  }

  const meta = extractTufGiftMeta(payload);
  if (meta.beneficiaryId && meta.months != null) {
    const ben = await User.findByPk(meta.beneficiaryId);
    if (ben) {
      await applyPurchaseEntitlementToBeneficiary(meta.beneficiaryId, meta.months, purchaser, event);
      return;
    }
  }

  const cpMode = String(extractCustomParameters(payload).tuf_checkout_mode ?? '').toLowerCase();
  const inferred = inferGiftMonthsFromXsollaPayload(payload);
  if (inferred != null && cpMode === 'gift') {
    await applyPurchaseEntitlementToBeneficiary(purchaserUserId, inferred, purchaser, event);
    return;
  }

  const paymentTxId = XsollaWebhookService.resolvePaymentTransactionId(payload, event);
  if (paymentTxId == null || !Number.isFinite(paymentTxId)) {
    logger.warn('[Xsolla] Payment skipped — no transaction id for one-time grant', {
      purchaserUserId,
      eventId: event.id,
    });
    return;
  }

  if (inferred != null && isTufStellarMonths(inferred)) {
    const wasActive = isTufStellarAccessActive(purchaser, purchaserBilling);
    const { inserted } = await appendPurchaseSegment({
      userId: purchaser.id,
      months: inferred,
      idempotencyKey: `seg:purchase:tx:${paymentTxId}`,
      xsollaTransactionId: paymentTxId,
      xsollaSubscriptionId: event.xsollaSubscriptionId,
      billingEventId: event.id,
    });

    try {
      await CacheInvalidation.invalidateUser(purchaser.id);
    } catch {
      /* best-effort */
    }

    await purchaser.reload();
    await purchaserBilling.reload();
    const nowActive = isTufStellarAccessActive(purchaser, purchaserBilling);

    if (
      ((!wasActive && nowActive) || inserted) &&
      purchaser.playerId != null
    ) {
      try {
        await ElasticsearchService.getInstance().reindexPlayers([purchaser.playerId]);
      } catch {
        /* best-effort */
      }
    }

    logger.info('[Xsolla] Self purchase entitlement applied', {
      purchaserUserId,
      months: inferred,
      segmentInserted: inserted,
    });
    return;
  }

  logger.warn('[Xsolla] Payment skipped — could not infer TUFStellar term from catalog payload', {
    purchaserUserId,
    eventId: event.id,
  });
}

/** Runs even when `TUF_STELLAR_ENABLED` is off so refunds stay consistent with stored segments. */
async function applyPurchaseRefundRevoke(event: BillingEvent): Promise<void> {
  const txId = event.xsollaTransactionId;
  if (txId == null || !Number.isFinite(Number(txId))) {
    logger.warn('[Xsolla] refund/order_canceled skipped — no xsolla transaction id', { eventId: event.id });
    return;
  }

  const sequelizeInst = UserTufStellarBilling.sequelize!;
  const affectedUserIds = await sequelizeInst.transaction(async (t) => {
    return revokePurchaseSegmentsByXsollaTransactionId(Number(txId), t);
  });

  if (affectedUserIds.length === 0) {
    logger.info('[Xsolla] refund/order_canceled — no entitlement segment matched transaction', {
      eventId: event.id,
      xsollaTransactionId: txId,
    });
    return;
  }

  for (const uid of affectedUserIds) {
    try {
      await CacheInvalidation.invalidateUser(uid);
    } catch {
      /* best-effort */
    }
    const u = await User.findByPk(uid);
    if (u?.playerId != null) {
      try {
        await ElasticsearchService.getInstance().reindexPlayers([u.playerId]);
      } catch {
        /* best-effort */
      }
    }
  }

  logger.info('[Xsolla] Purchase entitlement revoked for refund/order_canceled', {
    eventId: event.id,
    xsollaTransactionId: txId,
    affectedUserIds,
  });
}
