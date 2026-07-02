import { Router, Request, Response, NextFunction } from 'express';
import { Op } from 'sequelize';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  errorResponseSchema,
  standardErrorResponses401500,
  standardErrorResponses500,
} from '@/server/schemas/common.js';
import { User } from '@/models/index.js';
import BillingEvent from '@/models/billing/BillingEvent.js';
import { reconcileExpiredTufStellarAccess } from '@/misc/utils/subscriptions/tufStellarSubscription.js';
import { checkPurchaseCheckoutTransition, getBillingAllowedActions } from '@/misc/utils/subscriptions/billingLifecycleTransition.js';
import Stripe from 'stripe';
import {
  isTufStellarMonths,
  TUF_STELLAR_LIST_USD_PER_MONTH,
} from '@/server/services/billing/tufStellarProductCatalog.js';
import {
  buildTufStellarCheckoutLineItem,
  resolveCheckoutCurrency,
} from '@/server/services/billing/tufStellarStripeCheckoutLineItem.js';
import { buildTufStellarAccessSegmentsForUser } from '@/server/services/billing/tufStellarAccessSegments.js';
import { addCalendarMonthsUtc } from '@/misc/utils/time/addCalendarMonthsUtc.js';
import {
  describeProductFromStripeWebhookRawBody,
  describeProductFromXsollaWebhookRawBody,
  describeProductFromAdminGrantRawBody,
} from '@/server/services/billing/tufStellarBillingEventProduct.js';
import { isTufStellarFeatureEnabled, stripeConfig } from '@/config/app.config.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { deriveBillingAccessParts } from '@/misc/utils/subscriptions/billingAccessDerivation.js';
import {
  loadOrCreateUserTufStellarBilling,
  loadUserTufStellarBilling,
} from '@/server/services/billing/userTufStellarBillingSupport.js';
import { loadSegmentsForUser } from '@/server/services/billing/tufStellarEntitlementSegments.js';
import {
  createStripeClientForBillingRefunds,
  evaluateStripeTufStellarRefund,
  executeStripeTufStellarRefund,
  refundErrorResponseForEvaluation,
  TUF_STELLAR_STRIPE_REFUND_MAX_AGE_DAYS,
  TufStellarRefundIneligibleError,
} from '@/server/services/billing/tufStellarStripeUserRefund.js';
import { classifyBillingActivityKind } from '@/server/services/billing/billingActivityKind.js';
import { buildBillingPricingDisplayForRequest } from '@/server/services/billing/tufStellarDisplayPricingRegion.js';
import { stripeMinorToMajor } from '@/server/services/billing/stripeCurrencyMinorUnits.js';
import adminGrantsRouter from '@/server/routes/v3/billing/adminGrants.js';

const router: Router = Router();

router.use((_req: Request, res: Response, next: NextFunction) => {
  if (isTufStellarFeatureEnabled()) return next();
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  return res.status(404).json({
    error: { code: 'TUF_STELLAR_DISABLED', message: 'TUFStellar is not available on this deployment.' },
  });
});

router.use('/admin/grants', adminGrantsRouter);

function summarizeStripeEnvelope(payload: Record<string, unknown>): PaymentSummary | null {
  const t = typeof payload.type === 'string' ? payload.type : '';
  const dataObj = (payload.data as { object?: Record<string, unknown> } | undefined)?.object;
  if (!dataObj || typeof dataObj !== 'object') return null;
  if (t === 'checkout.session.completed' && String(dataObj.object) === 'checkout.session') {
    const total = dataObj.amount_total;
    const cur = dataObj.currency;
    const currency = typeof cur === 'string' ? cur.toUpperCase() : null;
    const cents = total != null ? Number(total) : NaN;
    const amount = Number.isFinite(cents) ? stripeMinorToMajor(cents, currency) : null;
    return {
      amount,
      currency,
    };
  }
  if (String(dataObj.object) === 'charge') {
    const cur = dataObj.currency;
    const currency = typeof cur === 'string' ? cur.toUpperCase() : null;
    // `charge.refunded` carries cumulative refunded minor units on `amount_refunded`; `amount` is the original charge.
    if (t === 'charge.refunded') {
      const refCents = dataObj.amount_refunded != null ? Number(dataObj.amount_refunded) : NaN;
      const amount = Number.isFinite(refCents) ? stripeMinorToMajor(refCents, currency) : null;
      return { amount, currency };
    }
    const amt = dataObj.amount != null ? Number(dataObj.amount) : NaN;
    const amount = Number.isFinite(amt) ? stripeMinorToMajor(amt, currency) : null;
    return {
      amount,
      currency,
    };
  }
  return null;
}

const BILLING_RECIPIENT_ES_LIMIT = 40;
const BILLING_RECIPIENT_RESPONSE_LIMIT = 15;

interface PaymentSummary {
  amount: number | null;
  currency: string | null;
}

function summarizeRawBody(rawBody: string): PaymentSummary {
  try {
    const payload = JSON.parse(rawBody) as Record<string, unknown>;
    const stripeSummary = summarizeStripeEnvelope(payload);
    if (stripeSummary) return stripeSummary;

    const p = payload as Record<string, any>;
    const tx = p?.transaction ?? p?.billing?.transaction;
    const amountRaw =
      tx?.payment_method_sum ??
      tx?.payment_gross ??
      p?.order?.amount ??
      p?.billing?.purchase?.total?.amount ??
      p?.purchase?.total?.amount ??
      p?.purchase?.checkout?.amount ??
      null;
    const currency =
      tx?.payment_method_currency ??
      p?.order?.currency ??
      p?.billing?.purchase?.total?.currency ??
      p?.purchase?.total?.currency ??
      p?.purchase?.checkout?.currency ??
      null;
    const amount = amountRaw != null ? Number(amountRaw) : null;
    return {
      amount: Number.isFinite(amount as number) ? (amount as number) : null,
      currency: typeof currency === 'string' ? currency : null,
    };
  } catch {
    return { amount: null, currency: null };
  }
}

type BillingEventReferenceKind =
  | 'invoice_id'
  | 'foreign_invoice'
  | 'order_id'
  | 'transaction_id'
  | 'subscription_id'
  | 'checkout_external_id';

interface BillingEventReference {
  kind: BillingEventReferenceKind;
  value: string;
}

function trimmedString(v: unknown): string | null {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

const BILLING_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Empty/absent ➔ null (self). Invalid format ➔ `'invalid'`. */
function parseOptionalRecipientUserId(v: unknown): string | null | 'invalid' {
  const s = trimmedString(v);
  if (!s) return null;
  if (!BILLING_UUID_RE.test(s)) return 'invalid';
  return s.toLowerCase();
}

function paymentIntentIdFromCheckoutSession(session: Stripe.Checkout.Session): string | null {
  const pi = session.payment_intent;
  if (typeof pi === 'string') {
    const id = pi.trim();
    return id.startsWith('pi_') ? id : null;
  }
  if (pi && typeof pi === 'object' && 'id' in pi && typeof (pi as { id: unknown }).id === 'string') {
    const id = String((pi as { id: string }).id).trim();
    return id.startsWith('pi_') ? id : null;
  }
  return null;
}

const STRIPE_CHECKOUT_SESSION_ID_RE = /^cs_[a-zA-Z0-9_]+$/;

const REFERENCE_KIND_ORDER: BillingEventReferenceKind[] = [
  'invoice_id',
  'foreign_invoice',
  'order_id',
  'transaction_id',
  'subscription_id',
  'checkout_external_id',
];

/**
 * Invoice / order identifiers from billing webhook JSON (Xsolla IPN or Stripe event envelope)
 * plus indexed columns on BillingEvent.
 */
function extractBillingEventReferences(
  rawBody: string,
  row: { xsollaTransactionId: number | null; xsollaSubscriptionId: number | null; externalId: string | null },
): BillingEventReference[] {
  const byKind = new Map<BillingEventReferenceKind, string>();

  const setIfEmpty = (kind: BillingEventReferenceKind, value: string | null) => {
    if (!value || byKind.has(kind)) return;
    byKind.set(kind, value);
  };

  try {
    const p = JSON.parse(rawBody) as Record<string, any>;
    if (typeof p?.type === 'string' && p?.data && typeof p.data === 'object') {
      const obj = (p.data as { object?: Record<string, unknown> }).object;
      if (obj && typeof obj === 'object') {
        if (String(obj.object) === 'checkout.session') {
          setIfEmpty('checkout_external_id', trimmedString(obj.id));
          const pi = obj.payment_intent;
          if (typeof pi === 'string') setIfEmpty('transaction_id', pi);
          else if (pi && typeof pi === 'object' && 'id' in pi) setIfEmpty('transaction_id', trimmedString((pi as { id: unknown }).id));
        }
        if (String(obj.object) === 'charge') {
          const pi = obj.payment_intent;
          if (typeof pi === 'string') setIfEmpty('transaction_id', pi);
          else if (pi && typeof pi === 'object' && 'id' in pi) setIfEmpty('transaction_id', trimmedString((pi as { id: unknown }).id));
        }
      }
    }

    const notif = (p?.notification as Record<string, any> | undefined) ?? p;
    const sub = p?.purchase as Record<string, any> | undefined;
    const purchaseSub = sub?.subscription as Record<string, any> | undefined;
    const order = (p?.order ?? sub?.order) as Record<string, any> | undefined;
    const tx = (p?.transaction ?? p?.billing?.transaction) as Record<string, any> | undefined;
    const settings = p?.settings as Record<string, any> | undefined;

    setIfEmpty('invoice_id', trimmedString(
      p?.invoice_id ?? p?.invoiceId ?? notif?.invoice_id ?? notif?.invoiceId ?? tx?.invoice_id,
    ));
    setIfEmpty('foreign_invoice', trimmedString(
      p?.foreign_invoice ?? p?.foreignInvoice ?? notif?.foreign_invoice ?? notif?.foreignInvoice,
    ));
    setIfEmpty('order_id', trimmedString(order?.id ?? order?.order_id));
    setIfEmpty('transaction_id', trimmedString(tx?.id ?? tx?.transaction_id));
    setIfEmpty('subscription_id', trimmedString(
      purchaseSub?.subscription_id ?? purchaseSub?.subscriptionId,
    ));
    setIfEmpty('checkout_external_id', trimmedString(
      tx?.external_id ?? tx?.externalId ?? settings?.external_id ?? settings?.externalId,
    ));
  } catch {
    /* ignore */
  }

  if (row.xsollaTransactionId != null && Number.isFinite(row.xsollaTransactionId)) {
    setIfEmpty('transaction_id', String(row.xsollaTransactionId));
  }
  if (row.xsollaSubscriptionId != null && Number.isFinite(row.xsollaSubscriptionId)) {
    setIfEmpty('subscription_id', String(row.xsollaSubscriptionId));
  }
  setIfEmpty('checkout_external_id', trimmedString(row.externalId));

  const out: BillingEventReference[] = [];
  for (const kind of REFERENCE_KIND_ORDER) {
    const v = byKind.get(kind);
    if (v) out.push({ kind, value: v });
  }
  return out;
}

function isTufStellarAccessActive(expiresAt: Date | null | undefined): boolean {
  if (!expiresAt) return false;
  const t = new Date(expiresAt).getTime();
  return Number.isFinite(t) && t > Date.now();
}

function setBillingJsonNoCache(res: Response): void {
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function billingDeny(res: Response, deny: { status: number; code: string; message: string }): Response {
  return res.status(deny.status).json({ error: { code: deny.code, message: deny.message } });
}

function parsePreviewMonthsQuery(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || !isTufStellarMonths(Math.floor(n))) return null;
  return Math.floor(n);
}

function computePurchasePreviewProjectedExpiry(expiresAt: Date | null | undefined, previewMonths: number, nowMs: number): string {
  const expMs = expiresAt ? new Date(expiresAt).getTime() : NaN;
  const tailMs = Number.isFinite(expMs) && expMs > nowMs ? expMs : nowMs;
  const projected = addCalendarMonthsUtc(new Date(tailMs), previewMonths);
  return projected.toISOString();
}

router.get(
  '/me',
  Auth.user(),
  ApiDoc({
    operationId: 'getBillingMe',
    summary: 'Get current TUFStellar access (one-time purchases)',
    description:
      'Returns stacked purchase entitlement (expiry-driven), per-segment breakdown (`accessSegments`), optional `preview` when `previewMonths` query matches catalog terms, allowed checkout actions, and `pricingDisplay` (marketing amounts by term, currency from `CF-IPCountry` when present). Invoice IDs appear on GET /me/events only.',
    tags: ['Billing'],
    security: ['bearerAuth'],
    query: {
      previewMonths: {
        required: false,
        description:
          'When set to an allowed term (1, 2, 3, 6, 9, 12), response includes `preview.projectedExpiresAt` after stacking that many calendar months.',
        schema: { type: 'integer', enum: [1, 2, 3, 6, 9, 12] },
      },
    },
    responses: {
      200: {
        description: 'Billing state',
        schema: {
          type: 'object',
          properties: {
            active: { type: 'boolean' },
            expiresAt: { type: 'string', format: 'date-time', nullable: true },
            allowedActions: {
              type: 'object',
              properties: {
                purchaseOneTime: { type: 'boolean' },
              },
            },
            access: {
              type: 'object',
              properties: {
                active: { type: 'boolean' },
                expiresAt: { type: 'string', format: 'date-time', nullable: true },
                purchaseFundedRemainingMs: { type: 'integer' },
              },
            },
            accessSegments: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  segmentId: { type: 'integer' },
                  months: { type: 'integer' },
                  startsAt: { type: 'string', format: 'date-time' },
                  endsAt: { type: 'string', format: 'date-time' },
                  remainingMs: { type: 'integer' },
                  source: { type: 'string', enum: ['self_purchase', 'gift_received', 'admin_grant', 'unknown'] },
                  giftFrom: {
                    type: 'object',
                    nullable: true,
                    properties: {
                      userId: { type: 'string', format: 'uuid' },
                      username: { type: 'string', nullable: true },
                    },
                  },
                  grantFrom: {
                    type: 'object',
                    nullable: true,
                    properties: {
                      userId: { type: 'string', format: 'uuid' },
                      username: { type: 'string', nullable: true },
                    },
                  },
                  durationKind: { type: 'string', enum: ['months', 'days'], nullable: true },
                  durationValue: { type: 'integer', nullable: true },
                },
              },
            },
            preview: {
              type: 'object',
              nullable: true,
              properties: {
                months: { type: 'integer' },
                projectedExpiresAt: { type: 'string', format: 'date-time' },
              },
            },
            pricingDisplay: {
              type: 'object',
              properties: {
                currency: { type: 'string', description: 'ISO 4217 display currency' },
                country: {
                  type: 'string',
                  nullable: true,
                  description: 'Cloudflare `CF-IPCountry` when sent to origin; null if absent',
                },
                amountsByMonths: {
                  type: 'object',
                  description: 'Major currency units per term length (string keys 1,2,3,6,9,12)',
                  properties: {
                    '1': { type: 'number' },
                    '2': { type: 'number' },
                    '3': { type: 'number' },
                    '6': { type: 'number' },
                    '9': { type: 'number' },
                    '12': { type: 'number' },
                  },
                },
              },
            },
          },
        },
      },
      ...standardErrorResponses401500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const tokenUser = req.user;
      if (!tokenUser) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });

      const user = await User.findByPk(tokenUser.id);
      if (!user) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });

      await reconcileExpiredTufStellarAccess(user);
      await user.reload();

      setBillingJsonNoCache(res);

      const billing = await loadUserTufStellarBilling(user.id);

      const segments = await loadSegmentsForUser(user.id);
      const segmentInputs = segments.map((s) => ({
        kind: 'purchase' as const,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
      }));

      const allowedActions = getBillingAllowedActions(user, billing);

      const accessActive = isTufStellarAccessActive(billing?.tufStellarSubscriptionExpiresAt ?? null);
      const derived = deriveBillingAccessParts(user, billing, segmentInputs);

      const nowMs = Date.now();
      const accessSegments = await buildTufStellarAccessSegmentsForUser(user.id, nowMs);

      const previewMonths = parsePreviewMonthsQuery(req.query.previewMonths);
      const preview =
        previewMonths != null
          ? {
              months: previewMonths,
              projectedExpiresAt: computePurchasePreviewProjectedExpiry(
                billing?.tufStellarSubscriptionExpiresAt ?? null,
                previewMonths,
                nowMs,
              ),
            }
          : null;

      const pricingDisplay = buildBillingPricingDisplayForRequest(req);

      return res.json({
        active: accessActive,
        expiresAt: billing?.tufStellarSubscriptionExpiresAt ?? null,
        allowedActions,
        access: {
          active: accessActive,
          expiresAt: billing?.tufStellarSubscriptionExpiresAt ?? null,
          purchaseFundedRemainingMs: derived.purchaseFundedRemainingMs,
        },
        accessSegments,
        preview,
        pricingDisplay,
      });
    } catch (e) {
      logger.error('GET /v3/billing/me failed', e);
      return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to load billing state' } });
    }
  },
);

router.get(
  '/me/events',
  Auth.user(),
  ApiDoc({
    operationId: 'getBillingMeEvents',
    summary: 'Recent billing events for the current user',
    description:
      'Returns recent BillingEvent rows (sanitized): event type, status, amount, references, optional `product` (catalog-resolved months), for disputes and clearer activity.',
    tags: ['Billing'],
    security: ['bearerAuth'],
    responses: {
      200: {
        description: 'List of recent billing events',
        schema: {
          type: 'object',
          properties: {
            events: { type: 'array' },
          },
        },
      },
      ...standardErrorResponses401500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const tokenUser = req.user;
      if (!tokenUser) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });

      setBillingJsonNoCache(res);

      const limitRaw = Number(req.query.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 100) : 20;

      const viewerId = String(tokenUser.id);
      const viewerLower = viewerId.toLowerCase();

      const rows = await BillingEvent.findAll({
        where: {
          [Op.or]: [
            { userId: viewerId },
            { userId: viewerLower },
            { beneficiaryUserId: viewerLower },
          ],
        },
        order: [['createdAt', 'DESC']],
        limit,
      });

      const idSet = new Set<string>();
      for (const r of rows) {
        if (r.userId) idSet.add(String(r.userId).toLowerCase());
        if (r.beneficiaryUserId) idSet.add(String(r.beneficiaryUserId).toLowerCase());
      }

      const counterpartyByUserId = new Map<string, { username: string; nickname: string | null }>();
      if (idSet.size > 0) {
        const urows = await User.findAll({
          where: { id: { [Op.in]: [...idSet] } },
          attributes: ['id', 'username', 'nickname'],
        });
        for (const u of urows) {
          counterpartyByUserId.set(String(u.id).toLowerCase(), {
            username: u.username,
            nickname: u.nickname ?? null,
          });
        }
      }

      const events = rows.map((r) => {
        const summary = summarizeRawBody(r.rawBody);
        const references = extractBillingEventReferences(r.rawBody, {
          xsollaTransactionId: r.xsollaTransactionId,
          xsollaSubscriptionId: r.xsollaSubscriptionId,
          externalId: r.externalId,
        });
        const activityKind = classifyBillingActivityKind(r, viewerId);
        const product =
          r.provider === 'stripe'
            ? describeProductFromStripeWebhookRawBody(r.rawBody)
            : r.provider === 'xsolla'
              ? describeProductFromXsollaWebhookRawBody(r.rawBody)
              : r.provider === 'admin'
                ? describeProductFromAdminGrantRawBody(r.rawBody)
                : null;

        let counterpartyUsername: string | null = null;
        let counterpartyNickname: string | null = null;
        if (
          (activityKind === 'gift_received' || activityKind === 'admin_grant_received') &&
          r.userId
        ) {
          const isSelfAdminGrant =
            activityKind === 'admin_grant_received' &&
            r.beneficiaryUserId &&
            String(r.userId).toLowerCase() === String(r.beneficiaryUserId).toLowerCase();
          if (!isSelfAdminGrant) {
            const cp = counterpartyByUserId.get(String(r.userId).toLowerCase());
            if (cp) {
              counterpartyUsername = cp.username;
              counterpartyNickname = cp.nickname;
            }
          }
        } else if (
          (activityKind === 'gift_sent' || activityKind === 'admin_grant_sent') &&
          r.beneficiaryUserId
        ) {
          const cp = counterpartyByUserId.get(String(r.beneficiaryUserId).toLowerCase());
          if (cp) {
            counterpartyUsername = cp.username;
            counterpartyNickname = cp.nickname;
          }
        }

        return {
          id: r.id,
          provider: r.provider,
          eventType: r.eventType,
          status: r.status,
          createdAt: r.createdAt,
          processedAt: r.processedAt,
          amount: summary.amount,
          currency: summary.currency,
          references,
          activityKind,
          counterpartyUsername,
          counterpartyNickname,
          product,
        };
      });

      return res.json({ events });
    } catch (e) {
      logger.error('GET /v3/billing/me/events failed', e);
      return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to load billing history' } });
    }
  },
);

router.get(
  '/recipient-search',
  Auth.user(),
  ApiDoc({
    operationId: 'getBillingRecipientSearch',
    summary: 'Search accounts for one-time purchase recipient',
    description:
      'Elasticsearch player search (name / username / nickname), only rows with a linked auth user; excludes you and banned/suspended accounts.',
    tags: ['Billing'],
    security: ['bearerAuth'],
    query: {
      q: {
        schema: { type: 'string' },
        description: 'Min 2 characters after trimming unsafe LIKE chars.',
      },
    },
    responses: {
      200: {
        description: 'Matching users',
        schema: {
          type: 'object',
          properties: {
            users: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  username: { type: 'string', nullable: true },
                  nickname: { type: 'string', nullable: true },
                  avatarUrl: { type: 'string', nullable: true },
                  playerId: { type: 'integer', nullable: true },
                },
              },
            },
          },
        },
      },
      ...standardErrorResponses401500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const tokenUser = req.user;
      if (!tokenUser) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });

      const purchaser = await User.findByPk(tokenUser.id);
      if (!purchaser) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });

      const purchaseGate = checkPurchaseCheckoutTransition(purchaser);
      if (!purchaseGate.ok) {
        return billingDeny(res, purchaseGate);
      }

      const es = ElasticsearchService.getInstance();
      const { hits } = await es.searchPlayers({
        text: req.query.q as string,
        showBanned: 'hide',
        requireLinkedUser: true,
        limit: BILLING_RECIPIENT_ES_LIMIT,
        offset: 0,
      });

      const selfId = String(tokenUser.id);
      const orderedUserIds: string[] = [];
      const seenUser = new Set<string>();
      for (const doc of hits as Array<{ user?: { id?: string | null } | null }>) {
        const uid = doc?.user?.id;
        if (typeof uid !== 'string' || uid.length === 0 || uid === selfId) continue;
        if (seenUser.has(uid)) continue;
        seenUser.add(uid);
        orderedUserIds.push(uid);
      }

      if (orderedUserIds.length === 0) {
        return res.json({ users: [] });
      }

      const rows = await User.findAll({
        where: {
          id: { [Op.in]: orderedUserIds },
          status: { [Op.notIn]: ['banned', 'suspended'] },
        },
        attributes: ['id', 'username', 'nickname', 'avatarUrl', 'playerId'],
      });

      const rank = new Map(orderedUserIds.map((id, idx) => [id, idx]));
      const sorted = [...rows].sort((a, b) => (rank.get(String(a.id)) ?? 999) - (rank.get(String(b.id)) ?? 999));
      const users = sorted.slice(0, BILLING_RECIPIENT_RESPONSE_LIMIT).map((u) => ({
        id: u.id,
        username: u.username ?? null,
        nickname: u.nickname ?? null,
        avatarUrl: u.avatarUrl ?? null,
        playerId: u.playerId != null && Number.isFinite(Number(u.playerId)) ? Number(u.playerId) : null,
      }));

      return res.json({ users });
    } catch (e) {
      logger.error('GET /v3/billing/recipient-search failed', e);
      return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Search failed' } });
    }
  },
);

router.post(
  '/stripe/checkout',
  Auth.user(),
  ApiDoc({
    operationId: 'postBillingStripeCheckout',
    summary: 'Start Stripe Checkout for a one-time TUFStellar purchase',
    description:
      'Creates a Checkout Session (stacked calendar-month access). `recipientUserId` optional UUID (defaults to yourself). `currency` optional: `auto` (geo-inferred, default) or an allowlisted ISO 4217 code.',
    tags: ['Billing'],
    security: ['bearerAuth'],
    requestBody: {
      required: true,
      description: '`months` term length; optional `recipientUserId` for gifting; optional `currency` (`auto` or ISO 4217).',
      schema: {
        type: 'object',
        properties: {
          months: { type: 'integer', enum: [1, 2, 3, 6, 9, 12] },
          recipientUserId: { type: 'string', format: 'uuid' },
          currency: {
            type: 'string',
            description: '`auto` (default, geo-inferred) or allowlisted ISO 4217 checkout currency',
          },
        },
        required: ['months'],
      },
    },
    responses: {
      200: {
        description: 'Stripe Checkout Session URL',
        schema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
          },
        },
      },
      400: { description: 'Misconfigured', schema: errorResponseSchema },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      409: { description: 'Conflict', schema: errorResponseSchema },
      502: { description: 'Stripe error', schema: errorResponseSchema },
      ...standardErrorResponses500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const tokenUser = req.user;
      if (!tokenUser) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });

      const user = await User.findByPk(tokenUser.id);
      if (!user) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });

      await reconcileExpiredTufStellarAccess(user);
      await user.reload();

      const billing = await loadOrCreateUserTufStellarBilling(user.id);

      const body = req.body as {
        months?: unknown;
        recipientUserId?: unknown;
        currency?: unknown;
      };

      const monthsRaw = body?.months;
      const months = typeof monthsRaw === 'number' ? monthsRaw : Number(monthsRaw);
      if (!Number.isFinite(months)) {
        return res.status(400).json({
          error: { code: 'INVALID_CHECKOUT_TERM', message: 'months must be a number' },
        });
      }

      const recipientParsed = parseOptionalRecipientUserId(body?.recipientUserId);
      if (recipientParsed === 'invalid') {
        return res.status(400).json({
          error: { code: 'INVALID_RECIPIENT_ID', message: 'recipientUserId must be a valid UUID when provided.' },
        });
      }
      const recipientRaw = recipientParsed;
      const beneficiaryId = recipientRaw ?? user.id;

      const purchaseGate = checkPurchaseCheckoutTransition(user);
      if (!purchaseGate.ok) {
        return billingDeny(res, purchaseGate);
      }

      if (!stripeConfig.secretKey) {
        return res.status(400).json({
          error: { code: 'MISCONFIGURED', message: 'Stripe is not configured (missing STRIPE_SECRET_KEY).' },
        });
      }

      if (!isTufStellarMonths(months)) {
        return res.status(400).json({
          error: {
            code: 'INVALID_CHECKOUT_TERM',
            message: 'months must be one of 1, 2, 3, 6, 9, or 12',
          },
        });
      }

      const currencyResolved = resolveCheckoutCurrency(req, body?.currency);
      if (!currencyResolved.ok) {
        return res.status(400).json({
          error: {
            code: currencyResolved.code,
            message: 'currency must be auto or a supported ISO 4217 code',
          },
        });
      }
      const checkoutCurrency = currencyResolved.currency;

      const lineItemBuilt = buildTufStellarCheckoutLineItem(months, checkoutCurrency);
      if (!lineItemBuilt.ok) {
        return res.status(400).json({
          error: {
            code: lineItemBuilt.code,
            message: 'Could not resolve checkout amount for this term and currency',
          },
        });
      }

      const beneficiary = await User.findByPk(beneficiaryId);
      if (!beneficiary) {
        return res.status(400).json({
          error: { code: 'GIFT_RECIPIENT_NOT_FOUND', message: 'Recipient user was not found.' },
        });
      }
      if (beneficiary.status === 'banned' || beneficiary.status === 'suspended') {
        return res.status(400).json({
          error: { code: 'GIFT_RECIPIENT_BLOCKED', message: 'Recipient cannot receive purchases in this account state.' },
        });
      }

      const beneficiaryEmail = beneficiary.email?.trim() || user.email?.trim();
      if (!beneficiaryEmail) {
        return res.status(400).json({
          error: {
            code: 'GIFT_EMAIL_REQUIRED',
            message: 'Recipient must have an email (or you must have one on file for self-purchase).',
          },
        });
      }

      await billing.update({
        tufStellarPendingGiftBeneficiaryUserId: beneficiary.id,
        tufStellarPendingGiftMonths: months,
      });

      const stripe = new Stripe(stripeConfig.secretKey, { typescript: true });
      const purchaserId = String(user.id).toLowerCase();
      const benId = String(beneficiary.id).toLowerCase();
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        success_url: stripeConfig.checkoutSuccessUrl,
        cancel_url: stripeConfig.checkoutCancelUrl,
        client_reference_id: purchaserId,
        customer_email: user.email?.trim() || undefined,
        metadata: {
          tuf_purchaser_id: purchaserId,
          tuf_beneficiary_id: benId,
          tuf_months: String(months),
          tuf_checkout_currency: checkoutCurrency,
        },
        payment_intent_data: {
          metadata: {
            tuf_purchaser_id: purchaserId,
            tuf_beneficiary_id: benId,
            tuf_months: String(months),
            tuf_checkout_currency: checkoutCurrency,
          },
        },
        line_items: [lineItemBuilt.lineItem],
      });

      if (!session.url) {
        return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Stripe did not return a checkout URL' } });
      }

      logger.debug('[Stripe] checkout one-time', {
        purchaserId: user.id,
        beneficiaryId: beneficiary.id,
        months,
        currency: checkoutCurrency,
        unitAmount: lineItemBuilt.unitAmount,
      });
      return res.json({ url: session.url });
    } catch (e: unknown) {
      if (e instanceof Stripe.errors.StripeError) {
        logger.error('[Stripe] checkout failed', {
          type: e.type,
          message: e.message,
        });
        return res.status(502).json({ error: { code: 'STRIPE_ERROR', message: e.message } });
      }
      logger.error('POST /v3/billing/stripe/checkout failed', e);
      return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to start checkout' } });
    }
  },
);

router.get(
  '/stripe/checkout-status',
  Auth.user(),
  ApiDoc({
    operationId: 'getBillingStripeCheckoutStatus',
    summary: 'Stripe Checkout session status for return URL polling',
    description:
      'Retrieves the Checkout Session from Stripe (must belong to the signed-in purchaser via metadata) and reports whether the matching `checkout.session.completed` billing row has been processed. Use after `success_url` redirect instead of inferring success from GET /me alone (gifts do not extend the purchaser\'s access).',
    tags: ['Billing'],
    security: ['bearerAuth'],
    query: {
      session_id: {
        required: true,
        schema: { type: 'string' },
        description: 'Stripe Checkout Session id (`cs_…`) from the success redirect.',
      },
    },
    responses: {
      200: { description: 'Checkout + fulfillment snapshot', schema: { type: 'object' } },
      400: { description: 'Bad session id or misconfigured', schema: errorResponseSchema },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      403: { description: 'Session not for this purchaser', schema: errorResponseSchema },
      404: { description: 'Session not found', schema: errorResponseSchema },
      502: { description: 'Stripe error', schema: errorResponseSchema },
      ...standardErrorResponses500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const tokenUser = req.user;
      if (!tokenUser) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });

      const rawSid = req.query.session_id ?? req.query.sessionId;
      const sessionId = typeof rawSid === 'string' ? rawSid.trim() : '';
      if (!sessionId || !STRIPE_CHECKOUT_SESSION_ID_RE.test(sessionId)) {
        return res.status(400).json({
          error: { code: 'INVALID_PARAMETER', message: 'session_id must be a Stripe Checkout Session id (cs_…).' },
        });
      }

      if (!stripeConfig.secretKey) {
        return res.status(400).json({
          error: { code: 'MISCONFIGURED', message: 'Stripe is not configured (missing STRIPE_SECRET_KEY).' },
        });
      }

      setBillingJsonNoCache(res);

      const stripe = new Stripe(stripeConfig.secretKey, { typescript: true });
      let session: Stripe.Checkout.Session;
      try {
        session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent'] });
      } catch (e: unknown) {
        if (e instanceof Stripe.errors.StripeInvalidRequestError && e.code === 'resource_missing') {
          return res.status(404).json({ error: { code: 'CHECKOUT_SESSION_NOT_FOUND', message: 'Checkout session not found.' } });
        }
        if (e instanceof Stripe.errors.StripeError) {
          return res.status(502).json({ error: { code: 'STRIPE_ERROR', message: e.message } });
        }
        throw e;
      }

      const viewerLower = String(tokenUser.id).toLowerCase();
      const purchaserMeta = parseOptionalRecipientUserId(session.metadata?.tuf_purchaser_id ?? session.metadata?.tufPurchaserId);
      if (!purchaserMeta || purchaserMeta === 'invalid' || purchaserMeta !== viewerLower) {
        return res.status(403).json({
          error: {
            code: 'CHECKOUT_SESSION_FORBIDDEN',
            message: 'This checkout session is not associated with the signed-in purchaser.',
          },
        });
      }

      const refId = trimmedString(session.client_reference_id)?.toLowerCase();
      if (refId && refId !== viewerLower) {
        return res.status(403).json({
          error: {
            code: 'CHECKOUT_SESSION_FORBIDDEN',
            message: 'This checkout session is not associated with the signed-in purchaser.',
          },
        });
      }

      const beneficiaryMeta = parseOptionalRecipientUserId(session.metadata?.tuf_beneficiary_id ?? session.metadata?.tufBeneficiaryId);
      const benNorm = beneficiaryMeta && beneficiaryMeta !== 'invalid' ? beneficiaryMeta : purchaserMeta;
      const isGift = Boolean(benNorm && purchaserMeta && benNorm !== purchaserMeta);

      const monthsRaw = session.metadata?.tuf_months ?? session.metadata?.tufMonths;
      const monthsNum = monthsRaw != null && monthsRaw !== '' ? Number(monthsRaw) : NaN;
      const months = Number.isFinite(monthsNum) && isTufStellarMonths(Math.floor(monthsNum)) ? Math.floor(monthsNum) : null;

      const piId = paymentIntentIdFromCheckoutSession(session);
      const externalCandidates = [piId, session.id].filter((x): x is string => Boolean(x));

      const billingRow =
        externalCandidates.length > 0
          ? await BillingEvent.findOne({
              where: {
                provider: 'stripe',
                eventType: 'checkout.session.completed',
                externalId: { [Op.in]: externalCandidates },
                [Op.or]: [{ userId: tokenUser.id }, { userId: viewerLower }],
              },
              order: [['createdAt', 'DESC']],
            })
          : null;

      const stripePaymentComplete =
        session.status === 'complete' && (session.payment_status === 'paid' || session.payment_status === 'no_payment_required');

      const fulfillmentReady = billingRow?.status === 'processed';
      const fulfillmentFailed = billingRow?.status === 'failed';

      return res.json({
        sessionId: session.id,
        paymentIntentId: piId,
        stripeSessionStatus: session.status,
        stripePaymentStatus: session.payment_status,
        stripePaymentComplete,
        isGift,
        beneficiaryUserId: isGift ? benNorm : null,
        months,
        billingEventId: billingRow?.id ?? null,
        billingEventStatus: billingRow?.status ?? null,
        fulfillmentReady,
        fulfillmentFailed,
      });
    } catch (e) {
      logger.error('GET /v3/billing/stripe/checkout-status failed', e);
      return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to load checkout status' } });
    }
  },
);

router.get(
  '/stripe/refund-preview',
  Auth.user(),
  ApiDoc({
    operationId: 'getBillingStripeRefundPreview',
    summary: 'Preview Stripe refund for a checkout billing event',
    description:
      'Returns eligibility and computed refund amounts (list-rate consumption for in-use segments). Does not mutate Stripe or the database.',
    tags: ['Billing'],
    security: ['bearerAuth'],
    query: {
      billingEventId: {
        required: true,
        schema: { type: 'integer' },
        description: '`BillingEvent.id` for a `checkout.session.completed` row.',
      },
    },
    responses: {
      200: {
        description: 'Refund evaluation',
        schema: { type: 'object' },
      },
      400: { description: 'Missing billingEventId or Stripe misconfigured', schema: errorResponseSchema },
      ...standardErrorResponses401500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const tokenUser = req.user;
      if (!tokenUser) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });

      const raw = req.query.billingEventId;
      const n = typeof raw === 'string' ? Number(raw) : Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        return res.status(400).json({
          error: { code: 'INVALID_PARAMETER', message: 'billingEventId must be a positive integer.' },
        });
      }

      const stripe = createStripeClientForBillingRefunds();
      if (!stripe) {
        return res.status(400).json({
          error: { code: 'MISCONFIGURED', message: 'Stripe is not configured (missing STRIPE_SECRET_KEY).' },
        });
      }

      setBillingJsonNoCache(res);

      const evaluation = await evaluateStripeTufStellarRefund({
        billingEventId: Math.floor(n),
        viewerUserId: tokenUser.id,
        stripe,
      });

      return res.json({
        ...evaluation,
        listUsdPerMonth: TUF_STELLAR_LIST_USD_PER_MONTH,
        maxRefundAgeDays: TUF_STELLAR_STRIPE_REFUND_MAX_AGE_DAYS,
      });
    } catch (e) {
      logger.error('GET /v3/billing/stripe/refund-preview failed', e);
      return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to load refund preview' } });
    }
  },
);

router.post(
  '/stripe/refund',
  Auth.user(),
  ApiDoc({
    operationId: 'postBillingStripeRefund',
    summary: 'Refund a Stripe TUFStellar checkout purchase',
    description:
      'Creates a Stripe refund (full or partial per policy). Entitlement is revoked when Stripe sends `charge.refunded`.',
    tags: ['Billing'],
    security: ['bearerAuth'],
    requestBody: {
      required: true,
      schema: {
        type: 'object',
        properties: { billingEventId: { type: 'integer' } },
        required: ['billingEventId'],
      },
    },
    responses: {
      200: {
        description: 'Refund created',
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            refundId: { type: 'string', nullable: true },
            refundCents: { type: 'integer' },
            mode: { type: 'string', enum: ['full', 'partial'] },
          },
        },
      },
      400: { description: 'Not eligible / zero amount / too old', schema: errorResponseSchema },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      403: { description: 'Gift or not purchaser', schema: errorResponseSchema },
      409: { description: 'Already refunded', schema: errorResponseSchema },
      502: { description: 'Stripe error', schema: errorResponseSchema },
      ...standardErrorResponses500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const tokenUser = req.user;
      if (!tokenUser) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });

      const user = await User.findByPk(tokenUser.id);
      if (!user) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });

      await reconcileExpiredTufStellarAccess(user);
      await user.reload();

      const purchaseGate = checkPurchaseCheckoutTransition(user);
      if (!purchaseGate.ok) {
        return billingDeny(res, purchaseGate);
      }

      const stripe = createStripeClientForBillingRefunds();
      if (!stripe) {
        return res.status(400).json({
          error: { code: 'MISCONFIGURED', message: 'Stripe is not configured (missing STRIPE_SECRET_KEY).' },
        });
      }

      const body = req.body as { billingEventId?: unknown };
      const idRaw = body?.billingEventId;
      const n = typeof idRaw === 'number' ? idRaw : Number(idRaw);
      if (!Number.isFinite(n) || n <= 0) {
        return res.status(400).json({
          error: { code: 'INVALID_PARAMETER', message: 'billingEventId must be a positive integer.' },
        });
      }

      setBillingJsonNoCache(res);

      try {
        const { evaluation, stripeRefundId } = await executeStripeTufStellarRefund({
          billingEventId: Math.floor(n),
          viewerUser: user,
          stripe,
        });
        return res.json({
          ok: true,
          refundId: stripeRefundId,
          refundCents: evaluation.refundCents,
          mode: evaluation.mode,
        });
      } catch (e: unknown) {
        if (e instanceof TufStellarRefundIneligibleError) {
          const r = refundErrorResponseForEvaluation(e.evaluation);
          return res.status(r.status).json({ error: { code: r.errorCode, message: r.message } });
        }
        if (e instanceof Stripe.errors.StripeError) {
          logger.error('[Stripe] User refund Stripe error', { message: e.message, type: e.type });
          return res.status(502).json({ error: { code: 'STRIPE_ERROR', message: e.message } });
        }
        throw e;
      }
    } catch (e) {
      logger.error('POST /v3/billing/stripe/refund failed', e);
      return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to process refund' } });
    }
  },
);

router.get(
  '/callback',
  ApiDoc({
    operationId: 'getBillingCallback',
    summary: 'Redirect to a specified URL',
    description: 'Redirect to a specified callback URL when being called from a tunneled URL',
    tags: ['Billing'],
  }),
  async (req: Request, res: Response) => {
    try {
      const url = req.query.url as string;
      if (!url) return res.status(400).json({ error: { code: 'INVALID_PARAMETER', message: 'No URL provided' } });
      return res.redirect(url);
    } catch (e) {
      logger.error('GET /v3/billing/callback failed', e);
      return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to redirect to URL' } });
    }
  },
);

export default router;
