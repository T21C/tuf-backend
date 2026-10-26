import type { Request } from 'express';
import {
  buildPricingDisplayAmountsByMonths,
  TUF_STELLAR_DISPLAY_CURRENCIES,
  defaultDisplayCurrency,
  type TufStellarDisplayCurrency,
  type TufStellarPricingAmountsByMonths,
} from '@/server/services/billing/tufStellarDisplayPriceMatrix.js';
import {
  displayCurrencyCodeFromCountry,
  resolveBillingDisplayCurrency,
  type BillingDisplayCurrencyInput,
  type TufStellarDisplayCurrencyPreference,
} from '@/server/services/billing/tufStellarDisplayCurrencyLocale.js';

export type { BillingDisplayCurrencyInput, TufStellarDisplayCurrencyPreference };

/** Best-effort: VPNs, travel, and proxies can skew inferred country. */
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
  const code = displayCurrencyCodeFromCountry(country);
  return (TUF_STELLAR_DISPLAY_CURRENCIES as readonly string[]).includes(code)
    ? (code as TufStellarDisplayCurrency)
    : defaultDisplayCurrency();
}

export interface BillingPricingDisplayPayload {
  currency: TufStellarDisplayCurrency;
  /** Country that selected `currency`: language, player country, or geo. Null when none apply. */
  country: string | null;
  amountsByMonths: TufStellarPricingAmountsByMonths;
}

export function buildBillingPricingDisplay(input: BillingDisplayCurrencyInput): BillingPricingDisplayPayload {
  const resolved = resolveBillingDisplayCurrency(input);
  const currency = displayCurrencyFromCountryCode(resolved.country);
  return {
    currency,
    country: resolved.country,
    amountsByMonths: buildPricingDisplayAmountsByMonths(currency),
  };
}

export function buildBillingPricingDisplayForRequest(
  req: Request,
  preference?: TufStellarDisplayCurrencyPreference,
): BillingPricingDisplayPayload {
  return buildBillingPricingDisplay({
    appLanguage: preference?.appLanguage,
    playerCountry: preference?.playerCountry,
    geoCountry: parseCfIpCountry(req),
  });
}
