import dotenv from 'dotenv';

dotenv.config();

/** Parses env booleans; unknown strings fall back to `defaultValue`. */
export function parseEnvBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw === '') return defaultValue;
  const s = raw.trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return defaultValue;
}

/**
 * When false (default if `TUF_STELLAR_ENABLED` unset), TUFStellar billing APIs, webhook grants,
 * and public stellar perks are disabled. Set `TUF_STELLAR_ENABLED=true` to enable.
 */
export function isTufStellarFeatureEnabled(): boolean {
  return parseEnvBool(process.env.TUF_STELLAR_ENABLED, false);
}

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

function resolveStripeCheckoutSuccessUrl(): string {
  const explicit = (process.env.STRIPE_CHECKOUT_SUCCESS_URL ?? '').trim();
  const env = process.env.NODE_ENV;
  if (env === 'production' || env === 'staging') {
    return explicit;
  }
  const base = String(clientUrlEnv || 'http://localhost:5173').replace(/\/$/, '');
  return `${base}/callback?billing=stripe&session_id={CHECKOUT_SESSION_ID}`;
}

function resolveStripeCheckoutCancelUrl(): string {
  const explicit = (process.env.STRIPE_CHECKOUT_CANCEL_URL ?? '').trim();
  const env = process.env.NODE_ENV;
  if (env === 'production' || env === 'staging') {
    return explicit;
  }
  const base = String(clientUrlEnv || 'http://localhost:5173').replace(/\/$/, '');
  return `${base}/settings/billing`;
}

/** Stripe Price IDs (`price_…`) for TUFStellar one-time terms; from Dashboard one-time prices. */
export interface StripeTufStellarPriceIds {
  m1: string;
  m2: string;
  m3: string;
  m6: string;
  m9: string;
  m12: string;
}

function readStripeTufStellarPriceIds(): StripeTufStellarPriceIds {
  const jsonRaw = (process.env.STRIPE_TUFSTELLAR_PRICE_IDS ?? '').trim();
  if (jsonRaw) {
    try {
      const o = JSON.parse(jsonRaw) as Record<string, string>;
      const pick = (k: string) => String(o[k] ?? '').trim();
      return {
        m1: pick('1'),
        m2: pick('2'),
        m3: pick('3'),
        m6: pick('6'),
        m9: pick('9'),
        m12: pick('12'),
      };
    } catch {
      /* fall through to discrete env vars */
    }
  }
  return {
    m1: (process.env.STRIPE_PRICE_TUFSTELLAR_1M ?? '').trim(),
    m2: (process.env.STRIPE_PRICE_TUFSTELLAR_2M ?? '').trim(),
    m3: (process.env.STRIPE_PRICE_TUFSTELLAR_3M ?? '').trim(),
    m6: (process.env.STRIPE_PRICE_TUFSTELLAR_6M ?? '').trim(),
    m9: (process.env.STRIPE_PRICE_TUFSTELLAR_9M ?? '').trim(),
    m12: (process.env.STRIPE_PRICE_TUFSTELLAR_12M ?? '').trim(),
  };
}

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  checkoutSuccessUrl: string;
  checkoutCancelUrl: string;
  tufStellarPriceIds: StripeTufStellarPriceIds;
}

export const stripeConfig: StripeConfig = {
  secretKey: (process.env.STRIPE_SECRET_KEY ?? '').trim(),
  webhookSecret: (process.env.STRIPE_WEBHOOK_SECRET ?? '').trim(),
  checkoutSuccessUrl: resolveStripeCheckoutSuccessUrl(),
  checkoutCancelUrl: resolveStripeCheckoutCancelUrl(),
  tufStellarPriceIds: readStripeTufStellarPriceIds(),
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
