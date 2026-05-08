import { Router, Request, Response } from 'express';
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
import { syncTufStellarPermissionFromExpiry } from '@/misc/utils/subscriptions/tufStellarSubscription.js';
import {
  checkCancelTransition,
  checkCheckoutTransition,
  checkResubscribeTransition,
  getBillingAllowedActions,
  getBillingLifecycleState,
  reconcileBillingLifecycleIfExpired,
  transitionBillingLifecycle,
} from '@/misc/utils/subscriptions/billingLifecycleTransition.js';
import { XsollaApiClient, XsollaApiError } from '@/server/services/billing/XsollaApiClient.js';
import { xsollaConfig } from '@/config/app.config.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';

const router: Router = Router();

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
      'Returns active flag, expiry, cancellation timestamp, external subscription id, persisted billing lifecycle, and allowed actions for checkout/cancel/resubscribe.',
    tags: ['Billing'],
    security: ['bearerAuth'],
    responses: {
      200: {
        description: 'Subscription state',
        schema: {
          type: 'object',
          properties: {
            active: { type: 'boolean' },
            plan: { type: 'string', nullable: true },
            expiresAt: { type: 'string', format: 'date-time', nullable: true },
            cancelledAt: { type: 'string', format: 'date-time', nullable: true },
            externalSubscriptionId: { type: 'string', nullable: true },
            lifecycle: {
              type: 'string',
              enum: ['inactive', 'active_renewing', 'active_cancelling', 'active_checkout_pending'],
            },
            allowedActions: {
              type: 'object',
              properties: {
                checkout: { type: 'boolean' },
                cancel: { type: 'boolean' },
                resubscribe: { type: 'boolean' },
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

      await syncTufStellarPermissionFromExpiry(user);
      await user.reload();

      if (await reconcileBillingLifecycleIfExpired(user)) {
        await user.reload();
      }

      const lifecycle = getBillingLifecycleState(user);
      const allowedActions = getBillingAllowedActions(user);

      return res.json({
        active: isSubscriptionActive(user.tufStellarSubscriptionExpiresAt ?? null),
        plan: xsollaConfig.subscriptionPlanId || null,
        expiresAt: user.tufStellarSubscriptionExpiresAt ?? null,
        cancelledAt: user.tufStellarSubscriptionCancelledAt ?? null,
        externalSubscriptionId: user.tufStellarSubscriptionExternalId ?? null,
        lifecycle,
        allowedActions,
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
    description: 'Returns the most recent BillingEvent rows for the authenticated user (sanitized; no raw body).',
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

      const rows = await BillingEvent.findAll({
        where: { userId: String(tokenUser.id) },
        order: [['createdAt', 'DESC']],
        limit,
      });

      const events = rows.map((r) => {
        const summary = summarizeRawBody(r.rawBody);
        return {
          id: r.id,
          provider: r.provider,
          eventType: r.eventType,
          status: r.status,
          xsollaTransactionId: r.xsollaTransactionId,
          xsollaSubscriptionId: r.xsollaSubscriptionId,
          createdAt: r.createdAt,
          processedAt: r.processedAt,
          amount: summary.amount,
          currency: summary.currency,
        };
      });

      return res.json({ events });
    } catch (e) {
      logger.error('GET /v3/billing/me/events failed', e);
      return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to load billing history' } });
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
      'Mints a Pay Station token for the configured TUFStellar subscription plan and returns a Pay Station URL the client should open.',
    tags: ['Billing'],
    security: ['bearerAuth'],
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

      await syncTufStellarPermissionFromExpiry(user);
      await user.reload();

      if (await reconcileBillingLifecycleIfExpired(user)) {
        await user.reload();
      }

      const checkoutGate = checkCheckoutTransition(user);
      if (!checkoutGate.ok) {
        return billingDeny(res, checkoutGate);
      }

      const returnUrl = `${xsollaConfig.redirectUrl}`;

      const result = await XsollaApiClient.createSubscriptionPayStationToken({
        userId: user.id,
        email: user.email ?? null,
        username: user.username ?? null,
        returnUrl,
      });

      logger.info('[Xsolla] checkout', { userId: user.id, sandbox: xsollaConfig.sandbox });
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
      'Calls the Xsolla subscriptions API to cancel the user\'s active recurring subscription. Benefits stay until the period ends; the cancel_subscription webhook updates DB state.',
    tags: ['Billing'],
    security: ['bearerAuth'],
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

      await syncTufStellarPermissionFromExpiry(user);
      await user.reload();

      if (await reconcileBillingLifecycleIfExpired(user)) {
        await user.reload();
      }

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

      logger.info('[Xsolla] cancel', { userId: user.id, subId });
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

      await syncTufStellarPermissionFromExpiry(user);
      await user.reload();

      if (await reconcileBillingLifecycleIfExpired(user)) {
        await user.reload();
      }

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
