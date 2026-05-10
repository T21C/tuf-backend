import crypto from 'crypto';
import { xsollaConfig } from '@/config/app.config.js';
import { logger } from '../core/LoggerService.js';
import axios from 'axios';

export class XsollaApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'XsollaApiError';
    this.status = status;
    this.body = body;
  }
}

export interface CreatePayStationTokenInput {
  /** Internal UUID stored on the user; matches the value Xsolla echoes back as user.id in webhooks. */
  userId: string;
  email?: string | null;
  username?: string | null;
  /** Where Pay Station should send the browser back after checkout. */
  returnUrl: string;
  /** Per-term recurring plan external ID (`MONTH_TO_PLAN_ID` in `tufStellarProductCatalog.ts`). */
  productId: string;
  /** Echoed on webhooks (e.g. `tuf_checkout_mode`). */
  customParameters?: Record<string, string | number | boolean>;
}

export interface CreateGiftPayStationTokenInput {
  /** User opening Pay Station (payer). */
  purchaserUserId: string;
  purchaserEmail?: string | null;
  purchaserUsername?: string | null;
  beneficiaryUserId: string;
  beneficiaryEmail: string;
  /** Gift / one-time item SKU from `resolveTufStellarGiftProductId(months)` (term-selected). */
  giftProductId: string;
  months: number;
  returnUrl: string;
  /** Forward for Xsolla currency selection (`X-User-Ip`); optional if `countryCode` is set. */
  clientIp?: string | null;
  /** ISO 3166-1 alpha-2; defaults to `xsollaConfig.paymentDefaultCountry`. */
  countryCode?: string | null;
}

export interface CreatePayStationTokenResult {
  token: string;
  url: string;
}

const MERCHANT_TOKEN_HOST = 'https://api.xsolla.com';

function basicAuth(): string {
  const cred = `${xsollaConfig.merchantId}:${xsollaConfig.apiKey}`;
  return `Basic ${Buffer.from(cred, 'utf8').toString('base64')}`;
}

/** Catalog admin payment token: Basic `project_id:api_key` (not merchant_id). @see Xsolla Payment-server-side auth. */
function projectScopedBasicAuth(): string {
  const cred = `${xsollaConfig.projectId}:${xsollaConfig.apiKey}`;
  return `Basic ${Buffer.from(cred, 'utf8').toString('base64')}`;
}

function paystationUrl(token: string): string {
  const host = xsollaConfig.sandbox ? 'sandbox-secure.xsolla.com' : 'secure.xsolla.com';
  return `https://${host}/paystation4/?token=${encodeURIComponent(token)}`;
}

/** Catalog API — Create payment token for purchase (virtual items). */
function catalogAdminPaymentTokenUrl(): string {
  if (!xsollaConfig.projectId) {
    throw new XsollaApiError('Xsolla configuration missing', 0, null);
  }
  const base = 'https://store.xsolla.com/api';
  return `${base}/v3/project/${encodeURIComponent(String(xsollaConfig.projectId))}/admin/payment/token`;
}

/** GET subscription — path has project + subscription id only (no user segment). @see https://developers.xsolla.com/api/subscriptions/subscriptions/get-subscription.md */
function merchantSubscriptionGetUrl(subscriptionId: string | number): string {
  if (!xsollaConfig.projectId) {
    throw new XsollaApiError('Xsolla configuration missing', 0, null);
  }
  return (
    `${MERCHANT_TOKEN_HOST}/merchant/v2` +
    `/projects/${encodeURIComponent(String(xsollaConfig.projectId))}` +
    `/subscriptions/${encodeURIComponent(String(subscriptionId))}`
  );
}

/** PUT subscription (status, timeshift) — requires user id in path. @see https://developers.xsolla.com/api/subscriptions/subscriptions/update-subscription.md */
function userSubscriptionUpdateUrl(userId: string, subscriptionId: string | number): string {
  if (!xsollaConfig.projectId) {
    throw new XsollaApiError('Xsolla configuration missing', 0, null);
  }
  return (
    `${MERCHANT_TOKEN_HOST}/merchant/v2` +
    `/projects/${encodeURIComponent(String(xsollaConfig.projectId))}` +
    `/users/${encodeURIComponent(userId)}` +
    `/subscriptions/${encodeURIComponent(String(subscriptionId))}`
  );
}

export class XsollaApiClient {
  /**
   * Mints a Pay Station token for the configured subscription plan, scoped to one user.
   * Reference: Xsolla Pay Station "Get token" merchant endpoint.
   */
  static async createSubscriptionPayStationToken(input: CreatePayStationTokenInput): Promise<CreatePayStationTokenResult> {
    if (!xsollaConfig.merchantId || !xsollaConfig.apiKey || !xsollaConfig.projectId || !xsollaConfig.subscriptionPlanId) {
      throw new XsollaApiError('Xsolla configuration missing', 0, null);
    }

    const url = `${MERCHANT_TOKEN_HOST}/merchant/v2/merchants/${encodeURIComponent(xsollaConfig.merchantId)}/token`;

    const subscription: Record<string, string> = {
      plan_id: input.productId,
      //product_id: input.productId, <- WILL THROW 3007 / 2002 + 2032 DO NOT ENABLE
    };

    const payload: Record<string, unknown> = {
      user: {
        id: { value: input.userId },
        ...(input.email ? { email: { value: input.email } } : {}),
        ...(input.username ? { name: { value: input.username } } : {}),
      },
      settings: {
        currency: 'USD',
        language: 'en',
        project_id: Number(xsollaConfig.projectId),
        /** Unique per Pay Station open; required when Publisher Account → Security has "Use external ID" enabled. */
        external_id: crypto.randomUUID(),
        ...(xsollaConfig.sandbox ? { mode: 'sandbox' as const } : {}),
        //return_url: input.returnUrl,
        ui: { size: 'medium' },
      },
      purchase: {
        subscription,
      },
    };

    if (input.customParameters && Object.keys(input.customParameters).length > 0) {
      payload.custom_parameters = input.customParameters;
    }


    logger.debug("Creating subscription pay station token", { payload });
    const res = await axios.post(url, payload, {
      headers: {
        'Authorization': basicAuth(),
        'Content-Type': 'application/json',
      },
    });

    if (res.status !== 200) {
      throw new XsollaApiError(`Xsolla token request failed (${res.status})`, res.status, res.data);
    }

    const data = res.data as { token?: string };
    const token = data?.token;
    if (!token) {
      throw new XsollaApiError('Xsolla token response missing token', res.status, data);
    }
    return { token, url: paystationUrl(token) };
  }

  /**
   * Pay Station token for gift / one-time item checkout (Catalog Payment-server-side).
   * SKU must match the Publisher Account virtual item for the selected term (`resolveTufStellarGiftProductId`).
   * Uses Basic auth `project_id:api_key` (project API key from Publisher Account).
   * @see https://developers.xsolla.com/api/catalog/payment-server-side/admin-create-payment-token/
   */
  static async createGiftPayStationToken(input: CreateGiftPayStationTokenInput): Promise<CreatePayStationTokenResult> {
    if (!xsollaConfig.apiKey || !xsollaConfig.projectId) {
      throw new XsollaApiError('Xsolla configuration missing', 0, null);
    }

    const sku = String(input.giftProductId ?? '').trim();
    if (!sku) {
      throw new XsollaApiError('Gift item SKU is required', 0, null);
    }

    const country =
      (input.countryCode && String(input.countryCode).trim().toUpperCase().slice(0, 2)) ||
      xsollaConfig.paymentDefaultCountry ||
      'US';

    const url = catalogAdminPaymentTokenUrl();

    const payload: Record<string, unknown> = {
      sandbox: Boolean(xsollaConfig.sandbox),
      user: {
        id: { value: input.purchaserUserId },
        ...(input.purchaserEmail ? { email: { value: input.purchaserEmail } } : {}),
        ...(input.purchaserUsername ? { name: { value: input.purchaserUsername } } : {}),
        country: { value: country },
      },
      purchase: {
        items: [{ sku, quantity: 1 }],
      },
      settings: {
        currency: 'USD',
        language: 'en',
        return_url: input.returnUrl,
        external_id: crypto.randomUUID(),
      },
      custom_parameters: {
        tuf_beneficiary_user_id: input.beneficiaryUserId,
        tuf_gift_months: String(input.months),
        tuf_checkout_mode: 'gift',
      },
    };

    const clientIp = input.clientIp?.trim();
    const headers: Record<string, string> = {
      Authorization: projectScopedBasicAuth(),
      'Content-Type': 'application/json',
    };
    if (clientIp) {
      headers['X-User-Ip'] = clientIp;
    }

    logger.debug('Creating gift item payment token (v3 admin)', {
      payload,
      url,
      projectId: xsollaConfig.projectId,
      sku,
      months: input.months,
      sandbox: xsollaConfig.sandbox,
    });

    const res = await axios.post(url, payload, {
      headers,
      validateStatus: () => true,
    });

    if (res.status !== 200 && res.status !== 201) {
      throw new XsollaApiError(`Xsolla payment token request failed (${res.status})`, res.status, res.data);
    }

    const data = res.data as { token?: string };
    const token = data?.token;
    if (!token) {
      throw new XsollaApiError('Xsolla token response missing token', res.status, data);
    }
    return { token, url: paystationUrl(token) };
  }

  /**
   * Subscription details including `date_next_charge` (merchant GET — no user path segment).
   * @see https://developers.xsolla.com/api/subscriptions/subscriptions/get-subscription.md
   */
  static async getSubscriptionDateNextCharge(
    _userId: string,
    subscriptionId: string | number,
  ): Promise<Date | null> {
    if (!xsollaConfig.merchantId || !xsollaConfig.apiKey || !xsollaConfig.projectId) {
      throw new XsollaApiError('Xsolla configuration missing', 0, null);
    }

    const url = merchantSubscriptionGetUrl(subscriptionId);
    const res = await axios.get(url, {
      headers: {
        Authorization: basicAuth(),
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
    });

    if (res.status !== 200) {
      throw new XsollaApiError(`Xsolla subscription GET failed (${res.status})`, res.status, res.data);
    }

    const data = res.data as Record<string, unknown>;
    const sub = (data.subscription ?? data) as Record<string, unknown>;
    const raw = sub.date_next_charge ?? sub.dateNextCharge;
    if (raw == null || raw === '') return null;
    const d = new Date(String(raw));
    return Number.isFinite(d.getTime()) ? d : null;
  }

  /** Postpone next billing by `days` (1–366 per Xsolla). Chunks automatically for larger totals. */
  static async postponeSubscriptionBillingByDays(
    userId: string,
    subscriptionId: string | number,
    totalDays: number,
  ): Promise<void> {
    if (!Number.isFinite(totalDays) || totalDays <= 0) return;
    let remaining = Math.ceil(totalDays);
    while (remaining > 0) {
      const chunk = Math.min(remaining, 366);
      await XsollaApiClient.putSubscriptionTimeshift(userId, subscriptionId, 'day', chunk);
      remaining -= chunk;
    }
  }

  /** Postpone next billing by whole months (1–12 per request; chunks for larger totals). */
  static async postponeSubscriptionBillingByMonths(
    userId: string,
    subscriptionId: string | number,
    totalMonths: number,
  ): Promise<void> {
    if (!Number.isFinite(totalMonths) || totalMonths <= 0) return;
    let remaining = Math.ceil(totalMonths);
    while (remaining > 0) {
      const chunk = Math.min(remaining, 12);
      await XsollaApiClient.putSubscriptionTimeshift(userId, subscriptionId, 'month', chunk);
      remaining -= chunk;
    }
  }

  /**
   * Merchant PUT `/users/{user}/subscriptions/{id}` — status, timeshift, or cancel+refund flags.
   * @see https://developers.xsolla.com/api/subscriptions/subscriptions/update-subscription.md
   */
  private static async putUserSubscriptionJson(
    userId: string,
    subscriptionId: string | number,
    body: Record<string, unknown>,
  ): Promise<void> {
    if (!xsollaConfig.merchantId || !xsollaConfig.apiKey || !xsollaConfig.projectId) {
      throw new XsollaApiError('Xsolla configuration missing', 0, null);
    }

    const url = userSubscriptionUpdateUrl(userId, subscriptionId);
    const res = await axios.put(url, body, {
      headers: {
        Authorization: basicAuth(),
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
    });

    if (res.status === 200 || res.status === 204) return;
    throw new XsollaApiError(`Xsolla subscription update failed (${res.status})`, res.status, res.data);
  }

  /** Billing postponement: `day` 1–366 or `month` 1–12 per Xsolla. */
  private static async putSubscriptionTimeshift(
    userId: string,
    subscriptionId: string | number,
    type: 'day' | 'month',
    value: number,
  ): Promise<void> {
    const max = type === 'day' ? 366 : 12;
    if (!Number.isFinite(value) || value < 1 || value > max) {
      throw new XsollaApiError(`timeshift ${type} value must be 1–${max}`, 0, null);
    }
    await XsollaApiClient.putUserSubscriptionJson(userId, subscriptionId, {
      timeshift: { type, value: String(Math.floor(value)) },
    });
  }

  /** Same merchant PUT as cancel; Xsolla accepts `status`: active | non_renewing | canceled. */
  private static async putUserSubscriptionStatus(
    userId: string,
    subscriptionId: string | number,
    status: 'active' | 'non_renewing' | 'canceled',
  ): Promise<void> {
    await XsollaApiClient.putUserSubscriptionJson(userId, subscriptionId, { status });
  }

  /**
   * Cancels a recurring subscription via Xsolla's subscriptions partner API.
   * Xsolla still serves benefits until the current period ends; the subsequent
   * `cancel_subscription` webhook will mark our `tufStellarSubscriptionCancelledAt`.
   */
  static async cancelUserSubscription(userId: string, subscriptionId: string | number): Promise<void> {
    return XsollaApiClient.putUserSubscriptionStatus(userId, subscriptionId, 'non_renewing');
  }

  /**
   * Hard-cancel in Xsolla (`canceled`). Not resumable via {@link reactivateUserSubscription}; user needs new checkout.
   * Optional `refundLastPayment` maps to `cancel_subscription_payment` (Xsolla: only with status `canceled`).
   * @see https://developers.xsolla.com/api/subscriptions/subscriptions/update-subscription.md
   */
  static async cancelUserSubscriptionImmediate(
    userId: string,
    subscriptionId: string | number,
    opts?: { refundLastPayment?: boolean },
  ): Promise<void> {
    const body: Record<string, unknown> = { status: 'canceled' };
    if (opts?.refundLastPayment) {
      body.cancel_subscription_payment = true;
    }
    await XsollaApiClient.putUserSubscriptionJson(userId, subscriptionId, body);
  }

  /** Sets subscription back to renewing (`active`) after a user-initiated non-renewing cancel. */
  static async reactivateUserSubscription(userId: string, subscriptionId: string | number): Promise<void> {
    return XsollaApiClient.putUserSubscriptionStatus(userId, subscriptionId, 'active');
  }
}

export default XsollaApiClient;
