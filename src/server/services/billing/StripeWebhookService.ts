import crypto from 'crypto';
import type { CreationAttributes } from 'sequelize';
import type Stripe from 'stripe';
import BillingEvent from '@/models/billing/BillingEvent.js';
import { User } from '@/models/index.js';
import { logger } from '@/server/services/core/LoggerService.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import { isTufStellarMonths } from '@/server/services/billing/tufStellarProductCatalog.js';
import { loadOrCreateUserTufStellarBilling } from '@/server/services/billing/userTufStellarBillingSupport.js';
import UserTufStellarBilling from '@/models/billing/UserTufStellarBilling.js';
import { revokePurchaseSegmentsByStripePaymentIntentId } from '@/server/services/billing/tufStellarEntitlementSegments.js';
import { isTufStellarFeatureEnabled } from '@/config/app.config.js';
import { applyPurchaseEntitlementToBeneficiary } from '@/server/services/billing/tufStellarPurchaseFulfillment.js';

const BENEFICIARY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normUuid(v: unknown): string | null {
  if (v == null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  return BENEFICIARY_UUID_RE.test(s) ? s : null;
}

function trimmedString(v: unknown): string | null {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

export class StripeWebhookService {
  static PROVIDER = 'stripe';

  static sha256Hex(rawBodyUtf8: string): string {
    return crypto.createHash('sha256').update(rawBodyUtf8, 'utf8').digest('hex').toLowerCase();
  }

  static extractFromStripeEvent(event: Stripe.Event): {
    userId: string | null;
    beneficiaryUserId: string | null;
    externalId: string | null;
  } {
    const t = event.type;
    if (t === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const md = session.metadata ?? {};
      const purchaser = normUuid(md.tuf_purchaser_id ?? md.tufPurchaserId);
      const beneficiary = normUuid(md.tuf_beneficiary_id ?? md.tufBeneficiaryId) ?? purchaser;
      const pi = session.payment_intent;
      const piId = typeof pi === 'string' ? pi : pi && typeof pi === 'object' && 'id' in pi ? String((pi as { id: string }).id) : null;
      return {
        userId: purchaser,
        beneficiaryUserId: beneficiary,
        externalId: piId ?? session.id ?? null,
      };
    }
    if (t === 'charge.refunded') {
      const charge = event.data.object as Stripe.Charge;
      const pi = charge.payment_intent;
      const piId = typeof pi === 'string' ? pi : pi && typeof pi === 'object' && 'id' in pi ? String((pi as { id: string }).id) : null;
      return { userId: null, beneficiaryUserId: null, externalId: piId };
    }
    return { userId: null, beneficiaryUserId: null, externalId: null };
  }

  static async recordIfNew(event: Stripe.Event): Promise<BillingEvent | null> {
    const rawBody = JSON.stringify(event);
    const rawBodySha256 = this.sha256Hex(rawBody);
    const idempotencyKey = event.id;
    const extracted = this.extractFromStripeEvent(event);

    let userId = extracted.userId;
    let beneficiaryUserId = extracted.beneficiaryUserId;
    if (event.type === 'charge.refunded' && extracted.externalId) {
      const pi = String(extracted.externalId).trim();
      const prior = await BillingEvent.findOne({
        where: {
          provider: this.PROVIDER,
          eventType: 'checkout.session.completed',
          externalId: pi,
        },
        order: [['createdAt', 'DESC']],
      });
      if (prior) {
        userId = prior.userId;
        beneficiaryUserId = prior.beneficiaryUserId;
      }
    }

    const createAttrs: CreationAttributes<BillingEvent> = {
      provider: this.PROVIDER,
      eventType: event.type,
      idempotencyKey,
      status: 'received',
      rawBody,
      rawBodySha256,
      userId,
      beneficiaryUserId,
      xsollaTransactionId: null,
      xsollaSubscriptionId: null,
      externalId: extracted.externalId,
      processedAt: null,
      failedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date(),
    };

    try {
      return await BillingEvent.create(createAttrs);
    } catch (e: unknown) {
      const name = (e as { name?: string })?.name || '';
      const msg = String((e as { message?: string })?.message || '');
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
      const payload = JSON.parse(event.rawBody) as Stripe.Event;
      switch (event.eventType) {
        case 'checkout.session.completed':
          await handleCheckoutSessionCompleted(event, payload);
          break;
        case 'charge.refunded':
          await handleChargeRefunded(event, payload);
          break;
        default:
          break;
      }
      await this.markProcessed(event.id);
    } catch (e) {
      logger.error('[Stripe] Failed to process billing event', { eventId: event.id, err: e });
      await this.markFailed(event.id, 'PROCESSING_ERROR', e instanceof Error ? e.message : 'Failed to process billing event');
      throw e;
    }
  }
}

function sessionPaymentIntentId(session: Stripe.Checkout.Session): string | null {
  const pi = session.payment_intent;
  if (typeof pi === 'string' && pi.trim()) return pi.trim();
  if (pi && typeof pi === 'object' && 'id' in pi && typeof (pi as { id: unknown }).id === 'string') {
    return String((pi as { id: string }).id).trim();
  }
  return null;
}

async function handleCheckoutSessionCompleted(event: BillingEvent, stripeEvent: Stripe.Event): Promise<void> {
  if (!isTufStellarFeatureEnabled()) {
    logger.info('[Stripe] checkout.session.completed skipped — TUF_STELLAR_ENABLED is off', { eventId: event.id });
    return;
  }

  const session = stripeEvent.data.object as Stripe.Checkout.Session;
  if (session.mode !== 'payment') {
    logger.info('[Stripe] checkout.session.completed ignored — not payment mode', { eventId: event.id, mode: session.mode });
    return;
  }

  const ps = session.payment_status;
  if (ps !== 'paid' && ps !== 'no_payment_required') {
    logger.info('[Stripe] checkout.session.completed skipped — payment not complete', { eventId: event.id, payment_status: ps });
    return;
  }

  const md = session.metadata ?? {};
  const purchaserId = normUuid(md.tuf_purchaser_id ?? md.tufPurchaserId);
  const beneficiaryId = normUuid(md.tuf_beneficiary_id ?? md.tufBeneficiaryId) ?? purchaserId;
  const monthsRaw = md.tuf_months ?? md.tufMonths;
  const months = monthsRaw != null && monthsRaw !== '' ? Number(monthsRaw) : NaN;

  if (!purchaserId || !beneficiaryId || !Number.isFinite(months) || !isTufStellarMonths(months)) {
    logger.warn('[Stripe] checkout.session.completed skipped — invalid metadata', {
      eventId: event.id,
      purchaserId,
      beneficiaryId,
      monthsRaw,
    });
    return;
  }

  const purchaser = await User.findByPk(purchaserId);
  if (!purchaser) {
    logger.warn('[Stripe] checkout.session.completed skipped — purchaser not found', { purchaserId, eventId: event.id });
    return;
  }

  const piId = sessionPaymentIntentId(session);

  const purchaserBilling = await loadOrCreateUserTufStellarBilling(purchaser.id);
  const pendingBen = purchaserBilling.tufStellarPendingGiftBeneficiaryUserId;
  const pendingMoRaw = purchaserBilling.tufStellarPendingGiftMonths;
  const pendingMo = pendingMoRaw != null ? Number(pendingMoRaw) : NaN;
  const pendingBenNorm = trimmedString(pendingBen)?.toLowerCase() ?? null;

  const pendingMatches =
    Boolean(pendingBenNorm) &&
    pendingBenNorm === beneficiaryId &&
    Number.isFinite(pendingMo) &&
    isTufStellarMonths(pendingMo) &&
    pendingMo === months;

  if ((pendingBenNorm || Number.isFinite(pendingMo)) && !pendingMatches) {
    logger.warn('[Stripe] checkout.session.completed — pending checkout mismatch; using session metadata', {
      eventId: event.id,
      pendingBen: pendingBenNorm,
      pendingMo,
      metaBeneficiary: beneficiaryId,
      metaMonths: months,
    });
  }

  await applyPurchaseEntitlementToBeneficiary({
    beneficiaryUserId: beneficiaryId,
    months,
    purchaser,
    billingEvent: event,
    idempotencyKeySuffix: event.idempotencyKey,
    stripePaymentIntentId: piId,
    xsollaTransactionId: null,
    xsollaSubscriptionId: null,
    logPrefix: '[Stripe]',
  });
}

/** Runs even when `TUF_STELLAR_ENABLED` is off so refunds stay consistent with stored segments. */
async function handleChargeRefunded(_event: BillingEvent, stripeEvent: Stripe.Event): Promise<void> {
  const charge = stripeEvent.data.object as Stripe.Charge;
  const pi = charge.payment_intent;
  const piId = typeof pi === 'string' ? pi.trim() : pi && typeof pi === 'object' && 'id' in pi ? String((pi as { id: string }).id).trim() : '';
  if (!piId) {
    logger.warn('[Stripe] charge.refunded skipped — no payment_intent', { eventId: _event.id });
    return;
  }

  const sequelizeInst = UserTufStellarBilling.sequelize!;
  const affectedUserIds = await sequelizeInst.transaction(async (t) => {
    return revokePurchaseSegmentsByStripePaymentIntentId(piId, t);
  });

  if (affectedUserIds.length === 0) {
    logger.info('[Stripe] charge.refunded — no entitlement segment matched payment_intent', {
      eventId: _event.id,
      paymentIntentId: piId,
    });
  } else {
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

    logger.info('[Stripe] Purchase entitlement revoked for charge.refunded', {
      eventId: _event.id,
      paymentIntentId: piId,
      affectedUserIds,
    });
  }

  await markStripePurchaseBillingRefunded(piId);
}

/** Marks the original `checkout.session.completed` row for this PaymentIntent so history shows refunded instead of done. */
async function markStripePurchaseBillingRefunded(paymentIntentId: string): Promise<void> {
  const pi = String(paymentIntentId).trim();
  if (!pi) return;
  const [rows] = await BillingEvent.update(
    { status: 'refunded' },
    {
      where: {
        provider: StripeWebhookService.PROVIDER,
        eventType: 'checkout.session.completed',
        externalId: pi,
        status: 'processed',
      },
    },
  );
  if (rows > 0) {
    logger.info('[Stripe] Marked checkout billing event as refunded', { paymentIntentId: pi, rows });
  }
}
