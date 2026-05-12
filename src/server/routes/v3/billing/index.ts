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
  resolveTufStellarStripePriceId,
} from '@/server/services/billing/tufStellarProductCatalog.js';
import { buildTufStellarAccessSegmentsForUser } from '@/server/services/billing/tufStellarAccessSegments.js';
import { addCalendarMonthsUtc } from '@/misc/utils/time/addCalendarMonthsUtc.js';
import {
  describeProductFromStripeWebhookRawBody,
  describeProductFromXsollaWebhookRawBody,
} from '@/server/services/billing/tufStellarBillingEventProduct.js';
import { isTufStellarFeatureEnabled, stripeConfig } from '@/config/app.config.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { deriveBillingAccessParts } from '@/misc/utils/subscriptions/billingAccessDerivation.js';
import {
  loadOrCreateUserTufStellarBilling,
  loadUserTufStellarBilling,
} from '@/server/services/billing/userTufStellarBillingSupport.js';
import { loadSegmentsForUser } from '@/server/services/billing/tufStellarEntitlementSegments.js';

const router: Router = Router();

router.use((_req: Request, res: Response, next: NextFunction) => {
  if (isTufStellarFeatureEnabled()) return next();
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  return res.status(404).json({
    error: { code: 'TUF_STELLAR_DISABLED', message: 'TUFStellar is not available on this deployment.' },
  });
});

function summarizeStripeEnvelope(payload: Record<string, unknown>): PaymentSummary | null {
  const t = typeof payload.type === 'string' ? payload.type : '';
  const dataObj = (payload.data as { object?: Record<string, unknown> } | undefined)?.object;
  if (!dataObj || typeof dataObj !== 'object') return null;
  if (t === 'checkout.session.completed' && String(dataObj.object) === 'checkout.session') {
    const total = dataObj.amount_total;
    const cur = dataObj.currency;
    const cents = total != null ? Number(total) : NaN;
    const amount = Number.isFinite(cents) ? cents / 100 : null;
    return {
      amount,
      currency: typeof cur === 'string' ? cur.toUpperCase() : null,
    };
  }
  if (String(dataObj.object) === 'charge') {
    const amt = dataObj.amount != null ? Number(dataObj.amount) : NaN;
    const cur = dataObj.currency;
    const amount = Number.isFinite(amt) ? amt / 100 : null;
    return {
      amount,
      currency: typeof cur === 'string' ? cur.toUpperCase() : null,
    };
  }
  return null;
}

type BillingActivityKind = 'gift_received' | 'gift_sent' | 'one_time_self' | 'default';

function classifyBillingActivityKind(row: BillingEvent, viewerUserId: string): BillingActivityKind {
  const me = String(viewerUserId).toLowerCase();
  const purchaserId = row.userId ? String(row.userId).toLowerCase() : '';
  const benId = row.beneficiaryUserId ? String(row.beneficiaryUserId).toLowerCase() : '';
  if (!benId) return 'default';
  if (benId === me && purchaserId && purchaserId !== me) return 'gift_received';
  if (purchaserId === me && benId === purchaserId) return 'one_time_self';
  if (purchaserId === me && benId !== purchaserId) return 'gift_sent';
  return 'default';
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
      'Returns stacked purchase entitlement (expiry-driven), per-segment breakdown (`accessSegments`), optional `preview` when `previewMonths` query matches catalog terms, and allowed checkout actions. Invoice IDs appear on GET /me/events only.',
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
                  source: { type: 'string', enum: ['self_purchase', 'gift_received', 'unknown'] },
                  giftFrom: {
                    type: 'object',
                    nullable: true,
                    properties: {
                      userId: { type: 'string', format: 'uuid' },
                      username: { type: 'string', nullable: true },
                    },
                  },
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
              : null;

        let counterpartyUsername: string | null = null;
        let counterpartyNickname: string | null = null;
        if (activityKind === 'gift_received' && r.userId) {
          const cp = counterpartyByUserId.get(String(r.userId).toLowerCase());
          if (cp) {
            counterpartyUsername = cp.username;
            counterpartyNickname = cp.nickname;
          }
        } else if (activityKind === 'gift_sent' && r.beneficiaryUserId) {
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
      'Creates a Checkout Session (stacked calendar-month access). `recipientUserId` optional UUID (defaults to yourself).',
    tags: ['Billing'],
    security: ['bearerAuth'],
    requestBody: {
      required: true,
      description: '`months` term length; optional `recipientUserId` for gifting.',
      schema: {
        type: 'object',
        properties: {
          months: { type: 'integer', enum: [1, 2, 3, 6, 9, 12] },
          recipientUserId: { type: 'string', format: 'uuid' },
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

      const priceId = resolveTufStellarStripePriceId(months);
      if (!priceId) {
        return res.status(400).json({
          error: {
            code: 'MISCONFIGURED',
            message: 'Stripe Price ID is not configured for this term (check STRIPE_PRICE_TUFSTELLAR_* or STRIPE_TUFSTELLAR_PRICE_IDS).',
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
        },
        payment_intent_data: {
          metadata: {
            tuf_purchaser_id: purchaserId,
            tuf_beneficiary_id: benId,
            tuf_months: String(months),
          },
        },
        line_items: [{ price: priceId, quantity: 1 }],
      });

      if (!session.url) {
        return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Stripe did not return a checkout URL' } });
      }

      logger.info('[Stripe] checkout one-time', {
        purchaserId: user.id,
        beneficiaryId: beneficiary.id,
        months,
        priceId,
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
