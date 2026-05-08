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

function paystationUrl(token: string): string {
  const host = xsollaConfig.sandbox ? 'sandbox-secure.xsolla.com' : 'secure.xsolla.com';
  return `https://${host}/paystation4/?token=${encodeURIComponent(token)}`;
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
      plan_id: xsollaConfig.subscriptionPlanId,
    };
    /*
    if (xsollaConfig.subscriptionProductId) {
      subscription.product_id = xsollaConfig.subscriptionProductId;
    }
    */

    const payload = {
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

  /** Same merchant PUT as cancel; Xsolla accepts `status`: active | non_renewing | canceled. */
  private static async putUserSubscriptionStatus(
    userId: string,
    subscriptionId: string | number,
    status: 'active' | 'non_renewing' | 'canceled',
  ): Promise<void> {
    if (!xsollaConfig.merchantId || !xsollaConfig.apiKey || !xsollaConfig.projectId) {
      throw new XsollaApiError('Xsolla configuration missing', 0, null);
    }

    const url = `${MERCHANT_TOKEN_HOST}/merchant/v2` +
      `/projects/${encodeURIComponent(xsollaConfig.projectId)}` +
      `/users/${encodeURIComponent(userId)}` +
      `/subscriptions/${encodeURIComponent(String(subscriptionId))}`;

    const res = await axios.put(url, { status }, {
      headers: {
        'Authorization': basicAuth(),
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
    });

    if (res.status === 200) return;
    throw new XsollaApiError(`Xsolla subscription update failed (${res.status})`, res.status, res.data);
  }

  /**
   * Cancels a recurring subscription via Xsolla's subscriptions partner API.
   * Xsolla still serves benefits until the current period ends; the subsequent
   * `cancel_subscription` webhook will mark our `tufStellarSubscriptionCancelledAt`.
   */
  static async cancelUserSubscription(userId: string, subscriptionId: string | number): Promise<void> {
    return XsollaApiClient.putUserSubscriptionStatus(userId, subscriptionId, 'non_renewing');
  }

  /** Sets subscription back to renewing (`active`) after a user-initiated non-renewing cancel. */
  static async reactivateUserSubscription(userId: string, subscriptionId: string | number): Promise<void> {
    return XsollaApiClient.putUserSubscriptionStatus(userId, subscriptionId, 'active');
  }
}

export default XsollaApiClient;
