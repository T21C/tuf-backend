/**
 * Stripe currency minor-unit conversion helpers.
 *
 * Stripe stores amounts in the currency's smallest unit. For most currencies that is
 * 1/100 of the major unit (e.g. USD cents), but "zero-decimal" currencies (e.g. KRW, JPY,
 * VND) have no sub-unit, so the stored amount already equals the major unit and must NOT be
 * divided by 100 for display.
 *
 * List mirrors Stripe's documented zero-decimal currencies:
 * https://docs.stripe.com/currencies#zero-decimal
 */
export const STRIPE_ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

export function isZeroDecimalCurrency(currency: string | null | undefined): boolean {
  if (!currency) return false;
  return STRIPE_ZERO_DECIMAL_CURRENCIES.has(currency.trim().toUpperCase());
}

/** Minor units per major unit for a currency (1 for zero-decimal, otherwise 100). */
export function currencyMinorUnitFactor(currency: string | null | undefined): number {
  return isZeroDecimalCurrency(currency) ? 1 : 100;
}

/** Convert a Stripe minor-unit amount to major units, respecting zero-decimal currencies. */
export function stripeMinorToMajor(minor: number, currency: string | null | undefined): number {
  return minor / currencyMinorUnitFactor(currency);
}

/** Convert a major-unit amount to Stripe minor units, respecting zero-decimal currencies. */
export function majorToStripeMinor(major: number, currency: string | null | undefined): number {
  return Math.round(major * currencyMinorUnitFactor(currency));
}
