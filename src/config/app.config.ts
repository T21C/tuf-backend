import dotenv from 'dotenv';

dotenv.config();

export const clientUrlEnv =
  process.env.NODE_ENV === 'production'
    ? process.env.PROD_CLIENT_URL
    : process.env.NODE_ENV === 'staging'
      ? process.env.STAGING_CLIENT_URL
      : process.env.NODE_ENV === 'development'
        ? process.env.CLIENT_URL
        : 'http://localhost:5173';

export const port =
  process.env.NODE_ENV === 'production'
    ? process.env.PROD_PORT
    : process.env.NODE_ENV === 'staging'
      ? process.env.STAGING_PORT
      : process.env.NODE_ENV === 'development'
        ? process.env.PORT
        : '3002';

export const ownUrl =
  process.env.NODE_ENV === 'production'
    ? process.env.PROD_API_URL
    : process.env.NODE_ENV === 'staging'
      ? process.env.STAGING_API_URL
      : process.env.NODE_ENV === 'development'
        ? process.env.DEV_URL
        : 'http://localhost:3002';

/** Pay Station `return_url`: after checkout the browser must hit the SPA route that reads `invoice_id` / `status`. */
function resolveXsollaRedirectUrl(): string {
  const explicit = (process.env.XSOLLA_REDIRECT_URL ?? '').trim();
  const env = process.env.NODE_ENV;
  if (env === 'production' || env === 'staging') {
    return explicit;
  }
  const base = String(clientUrlEnv || 'http://localhost:5173').replace(/\/$/, '');
  return `${base}/callback`;
}

export interface XsollaConfig {
  merchantId: string;
  projectId: string;
  apiKey: string;
  subscriptionPlanId: string;
  /** Required when the plan is linked to a subscription product (plan group) in Publisher Account. */
  subscriptionProductId: string;
  webhookSecret: string;
  redirectUrl: string;
  sandbox: boolean;
  /**
   * ISO 3166-1 alpha-2 country for Pay Station item tokens when `X-User-Ip` is not sent.
   * Xsolla requires country or IP for currency selection on Catalog POST .../admin/payment/token.
   */
  paymentDefaultCountry: string;
}

export const xsollaConfig: XsollaConfig = {
  merchantId: process.env.XSOLLA_MERCHANT_ID ?? '',
  projectId: process.env.XSOLLA_PROJECT_ID ?? '',
  apiKey: process.env.XSOLLA_API_KEY ?? '',
  subscriptionPlanId: process.env.XSOLLA_SUBSCRIPTION_PLAN_ID ?? '',
  subscriptionProductId: process.env.XSOLLA_SUBSCRIPTION_PRODUCT_ID ?? '',
  webhookSecret: process.env.XSOLLA_WEBHOOK_SECRET ?? '',
  sandbox: String(process.env.XSOLLA_SANDBOX ?? '').toLowerCase() === 'true',
  redirectUrl: resolveXsollaRedirectUrl(),
  paymentDefaultCountry: (process.env.XSOLLA_PAYMENT_DEFAULT_COUNTRY ?? 'US').trim().toUpperCase().slice(0, 2) || 'US',
};

export const corsOptions = {
  origin: [
    clientUrlEnv || 'http://localhost:5173',
    'http://localhost:5173',
    'https://tuforums.com',
    'https://api.tuforums.com',
  ],
  methods: [
    'GET',
    'POST',
    'PUT',
    'DELETE',
    'OPTIONS',
    'PATCH',
    'HEAD',
    'CONNECT',
    'TRACE',
  ],
  credentials: true,
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Cache-Control',
    'Pragma',
    'Expires',
    'Last-Event-ID',
    'X-Form-Type',
    'X-Super-Admin-Password',
    'X-File-Id',
    'X-Chunk-Index',
    'X-Total-Chunks',
    'If-None-Match',
    'If-Modified-Since'
  ],
  exposedHeaders: [
    'Content-Type',
    'Content-Length',
    'Authorization',
    'Cache-Control',
    'Pragma',
    'Expires',
    'Last-Event-ID',
    'X-Form-Type',
    'X-Super-Admin-Password',
    'X-File-Id',
    'X-Chunk-Index',
    'X-Total-Chunks',
    'ETag',
    'Last-Modified'
  ],
};
