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

export class XsollaApiClient {
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
}

export default XsollaApiClient;
