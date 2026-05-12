import { stripeConfig } from '@/config/app.config.js';

export { TUF_STELLAR_LIST_USD_PER_MONTH } from '@/server/services/billing/tufStellarRefundMath.js';

/** Allowlisted TUFStellar one-time catalog terms (virtual item SKUs / gift months). */
export const TUF_STELLAR_ALLOWED_MONTHS = [1, 2, 3, 6, 9, 12] as const;
export type TufStellarMonths = (typeof TUF_STELLAR_ALLOWED_MONTHS)[number];

const MONTH_TO_GIFT_PRODUCT_ID: Record<TufStellarMonths, string> = {
  1: 'TUFStellar_1_month',
  2: 'TUFStellar_2_months',
  3: 'TUFStellar_3_months',
  6: 'TUFStellar_6_months',
  9: 'TUFStellar_9_months',
  12: 'TUFStellar_12_months',
};

const GIFT_PRODUCT_ID_TO_MONTHS = new Map<string, TufStellarMonths>(
  (Object.entries(MONTH_TO_GIFT_PRODUCT_ID) as [string, string][]).map(([monthsKey, sku]) => [
    sku,
    Number(monthsKey) as TufStellarMonths,
  ]),
);

export function isTufStellarMonths(value: number): value is TufStellarMonths {
  return (TUF_STELLAR_ALLOWED_MONTHS as readonly number[]).includes(value);
}

export function resolveTufStellarGiftProductId(months: number): string | null {
  if (!isTufStellarMonths(months)) return null;
  return MONTH_TO_GIFT_PRODUCT_ID[months];
}

/** Stripe Dashboard one-time `price_…` id for the term, from `stripeConfig.tufStellarPriceIds`. */
export function resolveTufStellarStripePriceId(months: number): string | null {
  if (!isTufStellarMonths(months)) return null;
  const ids = stripeConfig.tufStellarPriceIds;
  const byTerm: Record<TufStellarMonths, string> = {
    1: ids.m1,
    2: ids.m2,
    3: ids.m3,
    6: ids.m6,
    9: ids.m9,
    12: ids.m12,
  };
  const id = String(byTerm[months] ?? '').trim();
  return id.length > 0 ? id : null;
}

/** Resolve gift SKU from webhook purchase payload (external id / sku string). */
export function monthsFromTufStellarGiftProductId(sku: string | null | undefined): TufStellarMonths | null {
  if (sku == null || sku === '') return null;
  const m = GIFT_PRODUCT_ID_TO_MONTHS.get(String(sku).trim());
  return m ?? null;
}

function giftMonthsFromXsollaCustomParameters(payload: any): TufStellarMonths | null {
  const cp =
    payload?.custom_parameters ??
    payload?.customParameters ??
    payload?.settings?.custom_parameters ??
    payload?.notification?.custom_parameters;
  if (!cp || typeof cp !== 'object') return null;
  const raw = (cp as Record<string, unknown>).tuf_gift_months ?? (cp as Record<string, unknown>).tufGiftMonths;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return isTufStellarMonths(n) ? n : null;
}

/** Deep-ish scan for a known gift SKU string inside Xsolla payload fragments. */
export function inferGiftMonthsFromXsollaPayload(payload: any): TufStellarMonths | null {
  const fromCp = giftMonthsFromXsollaCustomParameters(payload);
  if (fromCp != null) return fromCp;

  const candidates: unknown[] = [
    payload?.items?.[0]?.sku,
    payload?.items?.[0]?.product_id,
    payload?.purchase?.items?.[0]?.sku,
    payload?.purchase?.items?.[0]?.product_id,
  ];
  for (const c of candidates) {
    if (c == null || c === '') continue;
    const m = monthsFromTufStellarGiftProductId(String(c));
    if (m != null) return m;
  }
  return null;
}
