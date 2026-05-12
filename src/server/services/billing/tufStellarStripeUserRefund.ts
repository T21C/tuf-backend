import Stripe from 'stripe';
import BillingEvent from '@/models/billing/BillingEvent.js';
import User from '@/models/auth/User.js';
import UserTufStellarEntitlementSegment from '@/models/billing/UserTufStellarEntitlementSegment.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { stripeConfig } from '@/config/app.config.js';
import {
  TUF_STELLAR_LIST_USD_PER_MONTH,
  computeInUseRefundCents,
  consumedMonthEquivalent,
  listChargeCentsFromConsumedMonthEquiv,
} from '@/server/services/billing/tufStellarRefundMath.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';

/** Stripe maximum age for refunding a charge (days). */
export const TUF_STELLAR_STRIPE_REFUND_MAX_AGE_DAYS = 180;
const MAX_AGE_SEC = TUF_STELLAR_STRIPE_REFUND_MAX_AGE_DAYS * 24 * 60 * 60;

export type TufStellarRefundReasonCode =
  | 'ELIGIBLE'
  | 'NOT_FOUND'
  | 'NOT_STRIPE_CHECKOUT'
  | 'WRONG_STATUS'
  | 'NOT_PURCHASER'
  | 'GIFT_NOT_ALLOWED'
  | 'NO_PAYMENT_INTENT'
  | 'NO_SEGMENT'
  | 'SEGMENT_EXPIRED'
  | 'TOO_OLD'
  | 'ALREADY_REFUNDED'
  | 'ZERO_REFUND'
  | 'STRIPE_LOAD_FAILED';

export type TufStellarRefundMode = 'full' | 'partial';

export class TufStellarRefundIneligibleError extends Error {
  constructor(public readonly evaluation: TufStellarRefundEvaluation) {
    super('REFUND_INELIGIBLE');
    this.name = 'TufStellarRefundIneligibleError';
  }
}

export interface TufStellarRefundEvaluation {
  eligible: boolean;
  reasonCode: TufStellarRefundReasonCode;
  mode: TufStellarRefundMode | null;
  /** Amount we will request from Stripe (minor units, e.g. cents). */
  refundCents: number | null;
  paidCents: number | null;
  refundableCents: number | null;
  listChargeCents: number | null;
  consumedMonthEquiv: number | null;
  currency: string | null;
  paymentIntentId: string | null;
  segmentUserId: string | null;
}

function normId(v: string | null | undefined): string {
  return String(v ?? '').trim().toLowerCase();
}

/** Same rules as `classifyBillingActivityKind` in billing routes (gift_sent = purchaser gifted someone else). */
export function isGiftSentCheckout(row: BillingEvent, viewerUserId: string): boolean {
  const me = normId(viewerUserId);
  const purchaserId = row.userId ? normId(row.userId) : '';
  const benId = row.beneficiaryUserId ? normId(row.beneficiaryUserId) : '';
  if (!benId) return false;
  return purchaserId === me && benId !== purchaserId;
}

function isPurchaser(row: BillingEvent, viewerUserId: string): boolean {
  const me = normId(viewerUserId);
  const purchaserId = row.userId ? normId(row.userId) : '';
  return Boolean(purchaserId && purchaserId === me);
}

async function loadPaymentIntentAndCharge(
  stripe: Stripe,
  piId: string,
): Promise<{ charge: Stripe.Charge; paidCents: number } | null> {
  try {
    const pi = await stripe.paymentIntents.retrieve(piId, { expand: ['latest_charge'] });
    const lc = pi.latest_charge;
    if (!lc) return null;
    const charge = typeof lc === 'string' ? await stripe.charges.retrieve(lc) : lc;
    if (!charge || typeof charge.amount !== 'number') return null;
    const fromPi = typeof pi.amount_received === 'number' && pi.amount_received > 0 ? pi.amount_received : null;
    const paidCents = fromPi ?? charge.amount;
    return { charge, paidCents };
  } catch (e) {
    logger.warn('[Stripe] refund preview: failed to load PI/charge', { piId, err: e });
    return null;
  }
}

export async function evaluateStripeTufStellarRefund(params: {
  billingEventId: number;
  viewerUserId: string;
  stripe: Stripe;
  nowMs?: number;
}): Promise<TufStellarRefundEvaluation> {
  const nowMs = params.nowMs ?? Date.now();
  const empty = (reason: TufStellarRefundReasonCode): TufStellarRefundEvaluation => ({
    eligible: false,
    reasonCode: reason,
    mode: null,
    refundCents: null,
    paidCents: null,
    refundableCents: null,
    listChargeCents: null,
    consumedMonthEquiv: null,
    currency: null,
    paymentIntentId: null,
    segmentUserId: null,
  });

  const row = await BillingEvent.findByPk(params.billingEventId);
  if (!row) return empty('NOT_FOUND');

  if (row.provider !== 'stripe' || row.eventType !== 'checkout.session.completed') {
    return empty('NOT_STRIPE_CHECKOUT');
  }

  if (row.status !== 'processed') {
    return empty('WRONG_STATUS');
  }

  if (!isPurchaser(row, params.viewerUserId)) {
    return empty('NOT_PURCHASER');
  }

  if (isGiftSentCheckout(row, params.viewerUserId)) {
    return empty('GIFT_NOT_ALLOWED');
  }

  const piId = row.externalId ? String(row.externalId).trim() : '';
  if (!piId || !piId.startsWith('pi_')) {
    return empty('NO_PAYMENT_INTENT');
  }

  const segment = await UserTufStellarEntitlementSegment.findOne({
    where: {
      billingEventId: row.id,
      stripePaymentIntentId: piId,
    },
  });

  if (!segment) {
    return { ...empty('NO_SEGMENT'), paymentIntentId: piId };
  }

  const startMs = new Date(segment.startsAt).getTime();
  const endMs = new Date(segment.endsAt).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return { ...empty('NO_SEGMENT'), paymentIntentId: piId, segmentUserId: segment.userId };
  }

  if (nowMs >= endMs) {
    return {
      ...empty('SEGMENT_EXPIRED'),
      paymentIntentId: piId,
      segmentUserId: segment.userId,
    };
  }

  const loaded = await loadPaymentIntentAndCharge(params.stripe, piId);
  if (!loaded) {
    return { ...empty('STRIPE_LOAD_FAILED'), paymentIntentId: piId, segmentUserId: segment.userId };
  }
  const { charge, paidCents: paidBaseCents } = loaded;

  const ageSec = Math.floor(nowMs / 1000) - charge.created;
  if (ageSec > MAX_AGE_SEC) {
    return {
      ...empty('TOO_OLD'),
      paymentIntentId: piId,
      segmentUserId: segment.userId,
      currency: typeof charge.currency === 'string' ? charge.currency.toUpperCase() : null,
    };
  }

  const paidCents = paidBaseCents;
  const refundedSoFar = typeof charge.amount_refunded === 'number' ? charge.amount_refunded : 0;
  const refundableCents = Math.max(0, paidCents - refundedSoFar);
  if (refundableCents <= 0) {
    return {
      ...empty('ALREADY_REFUNDED'),
      paidCents,
      refundableCents: 0,
      currency: typeof charge.currency === 'string' ? charge.currency.toUpperCase() : null,
      paymentIntentId: piId,
      segmentUserId: segment.userId,
    };
  }

  const currency = typeof charge.currency === 'string' ? charge.currency.toUpperCase() : null;
  const months = Number(segment.months);

  let mode: TufStellarRefundMode;
  let refundCents: number;
  let listChargeCents: number | null = null;
  let consumedMonthEquiv: number | null = null;

  if (nowMs < startMs) {
    mode = 'full';
    refundCents = refundableCents;
  } else {
    mode = 'partial';
    consumedMonthEquiv = consumedMonthEquivalent(startMs, endMs, months, nowMs);
    listChargeCents = listChargeCentsFromConsumedMonthEquiv(consumedMonthEquiv, TUF_STELLAR_LIST_USD_PER_MONTH);
    refundCents = computeInUseRefundCents(paidCents, refundableCents, consumedMonthEquiv, TUF_STELLAR_LIST_USD_PER_MONTH);
  }

  if (refundCents <= 0) {
    return {
      eligible: false,
      reasonCode: 'ZERO_REFUND',
      mode,
      refundCents: 0,
      paidCents,
      refundableCents,
      listChargeCents,
      consumedMonthEquiv,
      currency,
      paymentIntentId: piId,
      segmentUserId: segment.userId,
    };
  }

  return {
    eligible: true,
    reasonCode: 'ELIGIBLE',
    mode,
    refundCents,
    paidCents,
    refundableCents,
    listChargeCents,
    consumedMonthEquiv,
    currency,
    paymentIntentId: piId,
    segmentUserId: segment.userId,
  };
}

function httpStatusForReason(code: TufStellarRefundReasonCode): { status: number; errorCode: string } {
  switch (code) {
    case 'GIFT_NOT_ALLOWED':
      return { status: 403, errorCode: 'REFUND_GIFT_NOT_ALLOWED' };
    case 'NOT_PURCHASER':
      return { status: 403, errorCode: 'REFUND_NOT_ELIGIBLE' };
    case 'TOO_OLD':
      return { status: 400, errorCode: 'REFUND_TOO_OLD' };
    case 'ALREADY_REFUNDED':
    case 'WRONG_STATUS':
      return { status: 409, errorCode: 'REFUND_ALREADY_REFUNDED' };
    case 'ZERO_REFUND':
      return { status: 400, errorCode: 'REFUND_ZERO_AMOUNT' };
    case 'NOT_FOUND':
      return { status: 404, errorCode: 'REFUND_NOT_ELIGIBLE' };
    case 'STRIPE_LOAD_FAILED':
      return { status: 502, errorCode: 'STRIPE_ERROR' };
    default:
      return { status: 400, errorCode: 'REFUND_NOT_ELIGIBLE' };
  }
}

export function refundErrorResponseForEvaluation(ev: TufStellarRefundEvaluation): { status: number; errorCode: string; message: string } {
  const { status, errorCode } = httpStatusForReason(ev.reasonCode);
  const messages: Partial<Record<TufStellarRefundReasonCode, string>> = {
    NOT_FOUND: 'Billing event not found.',
    NOT_STRIPE_CHECKOUT: 'Only Stripe checkout purchases can be refunded here.',
    WRONG_STATUS: 'This purchase is not in a refundable state.',
    NOT_PURCHASER: 'Only the purchaser can request this refund.',
    GIFT_NOT_ALLOWED: 'Gifts are not refundable.',
    NO_PAYMENT_INTENT: 'No Stripe payment is linked to this event.',
    NO_SEGMENT: 'No active entitlement segment is linked to this purchase.',
    SEGMENT_EXPIRED: 'This access period has already ended; nothing to refund.',
    TOO_OLD: `Refunds are only available within ${TUF_STELLAR_STRIPE_REFUND_MAX_AGE_DAYS} days of the original charge.`,
    ALREADY_REFUNDED: 'This charge has already been fully refunded.',
    ZERO_REFUND: 'Computed refund amount is zero.',
    STRIPE_LOAD_FAILED: 'Could not load payment details from Stripe.',
  };
  return {
    status,
    errorCode,
    message: messages[ev.reasonCode] ?? 'Refund is not available for this purchase.',
  };
}

export async function executeStripeTufStellarRefund(params: {
  billingEventId: number;
  viewerUser: User;
  stripe: Stripe;
}): Promise<{ evaluation: TufStellarRefundEvaluation; stripeRefundId: string | null }> {
  const evaluation = await evaluateStripeTufStellarRefund({
    billingEventId: params.billingEventId,
    viewerUserId: params.viewerUser.id,
    stripe: params.stripe,
  });

  if (!evaluation.eligible || evaluation.refundCents == null || !evaluation.paymentIntentId) {
    throw new TufStellarRefundIneligibleError(evaluation);
  }

  const idem = `tuf-billing-refund-${params.billingEventId}`;
  const refund = await params.stripe.refunds.create(
    {
      payment_intent: evaluation.paymentIntentId,
      amount: evaluation.refundCents,
    },
    { idempotencyKey: idem },
  );
  logger.info('[Stripe] User billing refund created', {
    billingEventId: params.billingEventId,
    refundId: refund.id,
    amount: evaluation.refundCents,
    mode: evaluation.mode,
  });

  const segmentUserId = evaluation.segmentUserId;
  if (segmentUserId) {
    try {
      await CacheInvalidation.invalidateUser(segmentUserId);
    } catch {
      /* best-effort */
    }
    const u = await User.findByPk(segmentUserId, { attributes: ['id', 'playerId'] });
    if (u?.playerId != null) {
      try {
        await ElasticsearchService.getInstance().reindexPlayers([u.playerId]);
      } catch {
        /* best-effort */
      }
    }
  }

  return { evaluation, stripeRefundId: refund.id };
}

export function createStripeClientForBillingRefunds(): Stripe | null {
  const key = stripeConfig.secretKey?.trim();
  if (!key) return null;
  return new Stripe(key, { typescript: true });
}

export {
  TUF_STELLAR_LIST_USD_PER_MONTH,
  computeInUseRefundCents,
  consumedMonthEquivalent,
  listChargeCentsFromConsumedMonthEquiv,
} from '@/server/services/billing/tufStellarRefundMath.js';
