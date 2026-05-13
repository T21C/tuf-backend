import type { Request } from 'express';
import {
  buildPricingDisplayAmountsByMonths,
  defaultDisplayCurrency,
  type TufStellarDisplayCurrency,
  type TufStellarPricingAmountsByMonths,
} from '@/server/services/billing/tufStellarDisplayPriceMatrix.js';

/** Best-effort: VPNs, travel, and proxies can skew inferred country. */
const EUROZONE_ALPHA2 = new Set<string>([
  'AT',
  'BE',
  'CY',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HR',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PT',
  'SK',
  'SI',
  'ES',
  'AD',
  'MC',
  'SM',
  'VA',
]);

const COUNTRY_TO_CURRENCY: Record<string, TufStellarDisplayCurrency> = {
  US: 'USD',
  KR: 'KRW',
  JP: 'JPY',
  SG: 'SGD',
  CN: 'CNY',
  TW: 'TWD',
  HK: 'HKD',
  VN: 'VND',
  TH: 'THB',
  PH: 'PHP',
  ID: 'IDR',
  MY: 'MYR',
  BR: 'BRL',
  PL: 'PLN',
  GB: 'GBP',
  CA: 'CAD',
  AU: 'AUD',
};

export function parseCfIpCountry(req: Request): string | null {
  if (process.env.NODE_ENV === 'development') return 'KR';
  const raw = req.get('cf-ipcountry') ?? req.get('CF-IPCountry');
  if (raw == null || raw === '') return null;
  const t = String(raw).trim().toUpperCase();
  if (t.length !== 2 || !/^[A-Z]{2}$/.test(t)) return null;
  if (t === 'XX' || t === 'T1') return null;
  return t;
}

export function displayCurrencyFromCountryCode(country: string | null | undefined): TufStellarDisplayCurrency {
  if (country == null || country === '') return defaultDisplayCurrency();
  const c = String(country).trim().toUpperCase();
  if (c.length !== 2) return defaultDisplayCurrency();
  if (EUROZONE_ALPHA2.has(c)) return 'EUR';
  return COUNTRY_TO_CURRENCY[c] ?? defaultDisplayCurrency();
}

export interface BillingPricingDisplayPayload {
  currency: TufStellarDisplayCurrency;
  /** Raw Cloudflare country when present; otherwise null. */
  country: string | null;
  amountsByMonths: TufStellarPricingAmountsByMonths;
}

export function buildBillingPricingDisplayForRequest(req: Request): BillingPricingDisplayPayload {
  const country = parseCfIpCountry(req);
  const currency = displayCurrencyFromCountryCode(country);
  return {
    currency,
    country,
    amountsByMonths: buildPricingDisplayAmountsByMonths(currency),
  };
}
