import { Router, Request, Response } from 'express';
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
import { reconcileExpiredTufStellarSubscription } from '@/misc/utils/subscriptions/tufStellarSubscription.js';
import {
  checkCancelTransition,
  checkGiftCheckoutTransition,
  checkResubscribeTransition,
  checkSubscriptionCheckoutTransition,
  getBillingAllowedActions,
  getBillingLifecycleState,
  hasRecurringSubscriptionId,
  transitionBillingLifecycle,
} from '@/misc/utils/subscriptions/billingLifecycleTransition.js';
import { XsollaApiClient, XsollaApiError } from '@/server/services/billing/XsollaApiClient.js';
import { applyXsollaSubscriptionTerminatedState } from '@/server/services/billing/XsollaWebhookService.js';
import {
  monthsFromTufStellarPlanExternalId,
  resolveTufStellarGiftProductId,
  resolveTufStellarProductId,
} from '@/server/services/billing/tufStellarProductCatalog.js';
import { xsollaConfig } from '@/config/app.config.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { deriveBillingAccessParts } from '@/misc/utils/subscriptions/billingAccessDerivation.js';
import { syncXsollaNextChargeToAccessExpiry } from '@/server/services/billing/tufStellarXsollaBillingSync.js';

const router: Router = Router();

/** Best-effort client IP for Xsolla `X-User-Ip` (currency); country still sent via token payload. */
function billingRequestClientIp(req: Request): string | undefined {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    return fwd.split(',')[0].trim();
  }
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) {
    return real.trim();
  }
  const raw = req.socket?.remoteAddress;
  return raw?.trim() || undefined;
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
    const payload = JSON.parse(rawBody);
    const amountRaw = payload?.transaction?.payment_method_sum ??
      payload?.transaction?.payment_gross ??
      payload?.purchase?.total?.amount ??
      payload?.purchase?.checkout?.amount ??
      null;
    const currency = payload?.transaction?.payment_method_currency ??
      payload?.purchase?.total?.currency ??
      payload?.purchase?.checkout?.currency ??
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

/** Empty/absent → null (self). Invalid format → `'invalid'`. */
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
 * Invoice / order identifiers from Xsolla webhook JSON plus indexed columns on BillingEvent.
 * Used for support and disputes; raw IPN body is never exposed to the client.
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
    const notif = (p?.notification as Record<string, any> | undefined) ?? p;
    const sub = p?.purchase as Record<string, any> | undefined;
    const purchaseSub = sub?.subscription as Record<string, any> | undefined;
    const order = sub?.order as Record<string, any> | undefined;
    const tx = p?.transaction as Record<string, any> | undefined;
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

function isSubscriptionActive(expiresAt: Date | null | undefined): boolean {
  if (!expiresAt) return false;
  const t = new Date(expiresAt).getTime();
  return Number.isFinite(t) && t > Date.now();
}

function billingDeny(res: Response, deny: { status: number; code: string; message: string }): Response {
  return res.status(deny.status).json({ error: { code: deny.code, message: deny.message } });
}

router.get(
  '/me',
  Auth.user(),
  ApiDoc({
    operationId: 'getBillingMe',
    summary: 'Get current TUFStellar subscription state',
    description:
      'Returns access (expiry-driven), recurring subscription lifecycle, cancellation timestamp, and allowed actions. Top-level `active`/`expiresAt` mirror access for compatibility. Invoice IDs appear on GET /me/events only.',
    tags: ['Billing'],
    security: ['bearerAuth'],
    responses: {
      200: {
        description: 'Subscription state',
        schema: {
          type: 'object',
          properties: {
            active: { type: 'boolean' },
            expiresAt: { type: 'string', format: 'date-time', nullable: true },
            cancelledAt: { type: 'string', format: 'date-time', nullable: true },
            lifecycle: {
              type: 'string',
              enum: ['inactive', 'active_renewing', 'active_cancelling', 'active_checkout_pending'],
            },
            allowedActions: {
              type: 'object',
              properties: {
                checkout: { type: 'boolean' },
                purchaseGift: { type: 'boolean' },
                purchaseSubscription: { type: 'boolean' },
                cancel: { type: 'boolean' },
                resubscribe: { type: 'boolean' },
              },
            },
            access: {
              type: 'object',
              properties: {
                active: { type: 'boolean' },
                expiresAt: { type: 'string', format: 'date-time', nullable: true },
                oneTimeRemainingMs: { type: 'integer' },
                recurringPeriodEndsAt: { type: 'string', format: 'date-time', nullable: true },
              },
            },
            subscription: {
              type: 'object',
              properties: {
                lifecycle: {
                  type: 'string',
                  enum: ['inactive', 'active_renewing', 'active_cancelling', 'active_checkout_pending'],
                },
                cancelledAt: { type: 'string', format: 'date-time', nullable: true },
                hasRecurringSubscription: { type: 'boolean' },
                termMonths: { type: 'integer', nullable: true },
                recurringPeriodEndsAt: { type: 'string', format: 'date-time', nullable: true },
                allowedActions: {
                  type: 'object',
                  properties: {
                    cancel: { type: 'boolean' },
                    resubscribe: { type: 'boolean' },
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

      await reconcileExpiredTufStellarSubscription(user);
      await user.reload();

      await syncXsollaNextChargeToAccessExpiry(user, 'lazy');
      await user.reload();

      const lifecycle = getBillingLifecycleState(user);
      const allowedActions = getBillingAllowedActions(user);

      const accessActive = isSubscriptionActive(user.tufStellarSubscriptionExpiresAt ?? null);
      const termMonths = monthsFromTufStellarPlanExternalId(user.tufStellarSubscriptionPlanExternalId ?? null);
      const derived = deriveBillingAccessParts(user);
      const recurringEnds = user.tufStellarRecurringPeriodEndAt ?? null;

      return res.json({
        active: accessActive,
        expiresAt: user.tufStellarSubscriptionExpiresAt ?? null,
        cancelledAt: user.tufStellarSubscriptionCancelledAt ?? null,
        lifecycle,
        allowedActions,
        access: {
          active: accessActive,
          expiresAt: user.tufStellarSubscriptionExpiresAt ?? null,
          oneTimeRemainingMs: derived.oneTimeRemainingMs,
          recurringPeriodEndsAt: recurringEnds,
        },
        subscription: {
          lifecycle,
          cancelledAt: user.tufStellarSubscriptionCancelledAt ?? null,
          hasRecurringSubscription: hasRecurringSubscriptionId(user),
          termMonths,
          recurringPeriodEndsAt: recurringEnds,
          allowedActions: {
            cancel: allowedActions.cancel,
            resubscribe: allowedActions.resubscribe,
          },
        },
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
      'Returns recent BillingEvent rows (sanitized): event type, status, amount, and structured invoice / reference ids parsed from the webhook payload for disputes.',
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

      const giftGate = checkGiftCheckoutTransition(purchaser);
      if (!giftGate.ok) {
        return billingDeny(res, giftGate);
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
  '/xsolla/checkout',
  Auth.user(),
  ApiDoc({
    operationId: 'postBillingXsollaCheckout',
    summary: 'Start an Xsolla Pay Station checkout',
    description:
      'Mints a Pay Station token: default `gift` mode uses gift SKUs (adds access time); `subscription` mode uses recurring plans. Omitted `mode` + `autoRenew` true implies subscription; otherwise gift. `recipientUserId` optional UUID for gifts (default yourself).',
    tags: ['Billing'],
    security: ['bearerAuth'],
    requestBody: {
      required: true,
      description:
        '`mode`: `gift` (default) = one-time gift time; `subscription` = recurring. `recipientUserId` optional UUID for gift beneficiary (default self). `autoRenew` only for `subscription` (self).',
      schema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['gift', 'subscription'] },
          months: { type: 'integer', enum: [1, 2, 3, 6, 9, 12] },
          recipientUserId: { type: 'string', format: 'uuid' },
          autoRenew: { type: 'boolean', default: false },
        },
        required: ['months'],
      },
    },
    responses: {
      200: {
        description: 'Pay Station token + URL',
        schema: {
          type: 'object',
          properties: {
            token: { type: 'string' },
            url: { type: 'string' },
          },
        },
      },
      400: { description: 'Misconfigured', schema: errorResponseSchema },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      409: { description: 'Invalid transition (e.g. already subscribed)', schema: errorResponseSchema },
      502: { description: 'Xsolla error', schema: errorResponseSchema },
      ...standardErrorResponses500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const tokenUser = req.user;
      if (!tokenUser) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });

      const user = await User.findByPk(tokenUser.id);
      if (!user) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });

      await reconcileExpiredTufStellarSubscription(user);
      await user.reload();

      const body = req.body as {
        mode?: unknown;
        months?: unknown;
        recipientUserId?: unknown;
        autoRenew?: unknown;
      };

      const monthsRaw = body?.months;
      const months = typeof monthsRaw === 'number' ? monthsRaw : Number(monthsRaw);
      if (!Number.isFinite(months)) {
        return res.status(400).json({
          error: { code: 'INVALID_CHECKOUT_TERM', message: 'months must be a number' },
        });
      }

      let mode: 'gift' | 'subscription';
      const modeRaw = body?.mode != null ? String(body.mode).toLowerCase() : '';
      if (modeRaw === 'gift' || modeRaw === 'subscription') {
        mode = modeRaw as 'gift' | 'subscription';
      } else {
        const arEarly = body?.autoRenew === true || String(body?.autoRenew).toLowerCase() === 'true';
        mode = arEarly ? 'subscription' : 'gift';
      }

      const arRaw = body?.autoRenew;
      const autoRenew = arRaw === true || String(arRaw).toLowerCase() === 'true';

      const recipientParsed = parseOptionalRecipientUserId(body?.recipientUserId);
      if (recipientParsed === 'invalid') {
        return res.status(400).json({
          error: { code: 'INVALID_RECIPIENT_ID', message: 'recipientUserId must be a valid UUID when provided.' },
        });
      }
      const recipientRaw = recipientParsed;
      const beneficiaryId = recipientRaw ?? user.id;

      const returnUrl = `${xsollaConfig.redirectUrl}`;

      if (mode === 'gift') {
        const giftGate = checkGiftCheckoutTransition(user);
        if (!giftGate.ok) {
          return billingDeny(res, giftGate);
        }

        const giftSku = resolveTufStellarGiftProductId(months);
        if (!giftSku) {
          return res.status(400).json({
            error: {
              code: 'INVALID_CHECKOUT_TERM',
              message: 'months must be one of 1, 2, 3, 6, 9, or 12',
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
            error: { code: 'GIFT_RECIPIENT_BLOCKED', message: 'Recipient cannot receive gifts in this account state.' },
          });
        }

        const beneficiaryEmail = beneficiary.email?.trim() || user.email?.trim();
        if (!beneficiaryEmail) {
          return res.status(400).json({
            error: {
              code: 'GIFT_EMAIL_REQUIRED',
              message: 'Recipient must have an email (or you must have one on file for self-gifts).',
            },
          });
        }

        await user.update({
          tufStellarPendingGiftBeneficiaryUserId: beneficiary.id,
          tufStellarPendingGiftMonths: months,
          tufStellarPendingAutoRenew: null,
        });

        const result = await XsollaApiClient.createGiftPayStationToken({
          purchaserUserId: user.id,
          purchaserEmail: user.email ?? null,
          purchaserUsername: user.username ?? null,
          beneficiaryUserId: beneficiary.id,
          beneficiaryEmail,
          giftProductId: giftSku,
          months,
          returnUrl,
          clientIp: billingRequestClientIp(req),
        });

        logger.info('[Xsolla] checkout gift', {
          purchaserId: user.id,
          beneficiaryId: beneficiary.id,
          sandbox: xsollaConfig.sandbox,
          months,
          giftSku,
        });
        return res.json(result);
      }

      const subGate = checkSubscriptionCheckoutTransition(user);
      if (!subGate.ok) {
        return billingDeny(res, subGate);
      }

      if (recipientRaw != null && recipientRaw !== user.id) {
        return res.status(400).json({
          error: {
            code: 'SUBSCRIPTION_SELF_ONLY',
            message: 'Recurring subscription checkout is only available for your own account.',
          },
        });
      }

      const productId = resolveTufStellarProductId(months);
      if (!productId) {
        return res.status(400).json({
          error: {
            code: 'INVALID_CHECKOUT_TERM',
            message: 'months must be one of 1, 2, 3, 6, 9, or 12',
          },
        });
      }

      await user.update({
        tufStellarPendingAutoRenew: autoRenew,
        tufStellarPendingGiftBeneficiaryUserId: null,
        tufStellarPendingGiftMonths: null,
      });

      const result = await XsollaApiClient.createSubscriptionPayStationToken({
        userId: user.id,
        email: user.email ?? null,
        username: user.username ?? null,
        returnUrl,
        productId,
        customParameters: { tuf_checkout_mode: 'subscription' },
      });

      logger.info('[Xsolla] checkout subscription', {
        userId: user.id,
        sandbox: xsollaConfig.sandbox,
        months,
        autoRenew,
        productId,
      });
      return res.json(result);
    } catch (e) {
      if (e instanceof XsollaApiError) {
        logger.error('[Xsolla] checkout failed', {
          status: e.status,
          message: e.message,
          xsolla: e.body,
        });
        const status = e.status === 0 ? 400 : 502;
        const code = e.status === 0 ? 'MISCONFIGURED' : 'XSOLLA_ERROR';
        return res.status(status).json({ error: { code, message: e.message } });
      }
      logger.error('POST /v3/billing/xsolla/checkout failed', e);
      return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to start checkout' } });
    }
  },
);

router.post(
  '/xsolla/cancel',
  Auth.user(),
  ApiDoc({
    operationId: 'postBillingXsollaCancel',
    summary: 'Cancel the current TUFStellar subscription',
    description:
      'Calls the Xsolla subscriptions API to cancel the user\'s active recurring subscription. Default: `non_renewing` (benefits until period end; can resume). Optional `immediate: true` uses status `canceled` (fully terminated in Xsolla; cannot resubscribe — new checkout only). Optional `refundLastPayment: true` only with `immediate: true` sets Xsolla `cancel_subscription_payment`.',
    tags: ['Billing'],
    security: ['bearerAuth'],
    requestBody: {
      required: false,
      description:
        'Omit body for standard cancel-at-period-end (`non_renewing`). Set `immediate: true` for instant termination (`canceled`).',
      schema: {
        type: 'object',
        properties: {
          immediate: { type: 'boolean', description: 'If true, hard-cancel via Xsolla (no resume).' },
          refundLastPayment: {
            type: 'boolean',
            description: 'If true with `immediate`, request refund of the last subscription payment (Xsolla API).',
          },
        },
      },
    },
    responses: {
      200: { description: 'Cancellation requested', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
      400: { description: 'No active subscription or not ready to cancel', schema: errorResponseSchema },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      502: { description: 'Xsolla error', schema: errorResponseSchema },
      ...standardErrorResponses500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const tokenUser = req.user;
      if (!tokenUser) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });

      const user = await User.findByPk(tokenUser.id);
      if (!user) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });

      await reconcileExpiredTufStellarSubscription(user);
      await user.reload();

      const cancelGate = checkCancelTransition(user);
      if (!cancelGate.ok) {
        return billingDeny(res, cancelGate);
      }
      if ('idempotent' in cancelGate && cancelGate.idempotent) {
        logger.info('[Xsolla] cancel idempotent (already pending)', { userId: user.id });
        return res.json({ ok: true });
      }

      const subId = user.tufStellarSubscriptionExternalId;
      if (!subId || subId.startsWith('tx:')) {
        return res.status(400).json({ error: { code: 'NO_ACTIVE_SUBSCRIPTION', message: 'No active recurring subscription found' } });
      }

      const immediate = Boolean(req.body?.immediate);
      const refundLastPayment = Boolean(req.body?.refundLastPayment);
      if (refundLastPayment && !immediate) {
        return res.status(400).json({
          error: {
            code: 'INVALID_CANCEL_OPTIONS',
            message: 'refundLastPayment requires immediate cancel (status canceled).',
          },
        });
      }
      if (immediate) {
        await XsollaApiClient.cancelUserSubscriptionImmediate(user.id, subId, {
          refundLastPayment,
        });
        await applyXsollaSubscriptionTerminatedState(user.id);
      } else {
        await XsollaApiClient.cancelUserSubscription(user.id, subId);

        const prevLifecycle = getBillingLifecycleState(user);
        const nextLifecycle = transitionBillingLifecycle(prevLifecycle, { type: 'user_cancel_committed' });
        await user.update({
          tufStellarSubscriptionCancelledAt: user.tufStellarSubscriptionCancelledAt ?? new Date(),
          tufStellarBillingLifecycleState: nextLifecycle,
        });
        try {
          await CacheInvalidation.invalidateUser(user.id);
        } catch {
          /* best-effort */
        }
      }

      logger.info('[Xsolla] cancel', { userId: user.id, subId, immediate });
      return res.json({ ok: true });
    } catch (e) {
      if (e instanceof XsollaApiError) {
        logger.error('[Xsolla] cancel failed', { status: e.status, message: e.message });
        const status = e.status === 0 ? 400 : 502;
        const code = e.status === 0 ? 'MISCONFIGURED' : 'XSOLLA_ERROR';
        return res.status(status).json({ error: { code, message: e.message } });
      }
      logger.error('POST /v3/billing/xsolla/cancel failed', e);
      return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to cancel subscription' } });
    }
  },
);

router.post(
  '/xsolla/resubscribe',
  Auth.user(),
  ApiDoc({
    operationId: 'postBillingXsollaResubscribe',
    summary: 'Resume a subscription marked non-renewing',
    description:
      'Calls the Xsolla subscriptions API with status active to undo a pending cancellation. Requires an existing recurring subscription id and a prior user cancel (cancelledAt set).',
    tags: ['Billing'],
    security: ['bearerAuth'],
    responses: {
      200: { description: 'Subscription resumed', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
      400: { description: 'Not in resubscribe-eligible state', schema: errorResponseSchema },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      409: {
        description:
          'Xsolla rejected resume (e.g. subscription fully canceled). Local state reconciled; start a new subscription checkout.',
        schema: errorResponseSchema,
      },
      502: { description: 'Xsolla error', schema: errorResponseSchema },
      ...standardErrorResponses500,
    },
  }),
  async (req: Request, res: Response) => {
    const tokenUser = req.user;
    try {
      if (!tokenUser) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });

      const user = await User.findByPk(tokenUser.id);
      if (!user) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });

      await reconcileExpiredTufStellarSubscription(user);
      await user.reload();

      const resubGate = checkResubscribeTransition(user);
      if (!resubGate.ok) {
        return billingDeny(res, resubGate);
      }

      const subId = user.tufStellarSubscriptionExternalId;
      if (!subId || subId.startsWith('tx:')) {
        return res.status(400).json({
          error: { code: 'NO_ACTIVE_SUBSCRIPTION', message: 'No recurring subscription found to resume' },
        });
      }

      await XsollaApiClient.reactivateUserSubscription(user.id, subId);

      const prevLifecycle = getBillingLifecycleState(user);
      const nextLifecycle = transitionBillingLifecycle(prevLifecycle, { type: 'user_resubscribe_committed' });
      await user.update({
        tufStellarSubscriptionCancelledAt: null,
        tufStellarBillingLifecycleState: nextLifecycle,
      });
      try {
        await CacheInvalidation.invalidateUser(user.id);
      } catch {
        /* best-effort */
      }

      logger.info('[Xsolla] resubscribe', { userId: user.id, subId });
      return res.json({ ok: true });
    } catch (e) {
      if (e instanceof XsollaApiError) {
        logger.error('[Xsolla] resubscribe failed', { status: e.status, message: e.message });
        if (e.status === 422 && tokenUser?.id) {
          try {
            await applyXsollaSubscriptionTerminatedState(tokenUser.id);
          } catch (reconcileErr) {
            logger.error('[Xsolla] resubscribe 422 reconcile failed', reconcileErr);
          }
          return res.status(409).json({
            error: {
              code: 'SUBSCRIPTION_TERMINATED_USE_CHECKOUT',
              message:
                'This subscription was fully canceled in Xsolla and cannot be resumed. Start a new subscription checkout.',
            },
          });
        }
        const status = e.status === 0 ? 400 : 502;
        const code = e.status === 0 ? 'MISCONFIGURED' : 'XSOLLA_ERROR';
        return res.status(status).json({ error: { code, message: e.message } });
      }
      logger.error('POST /v3/billing/xsolla/resubscribe failed', e);
      return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to resume subscription' } });
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
