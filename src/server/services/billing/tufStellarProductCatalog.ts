/** Allowlisted TUFStellar subscription products (Xsolla subscription product external IDs). */
export const TUF_STELLAR_ALLOWED_MONTHS = [1, 2, 3, 6, 9, 12] as const;
export type TufStellarMonths = (typeof TUF_STELLAR_ALLOWED_MONTHS)[number];

const MONTH_TO_PLAN_ID: Record<TufStellarMonths, string> = {
  1: 'BxY7sHoH',
  2: '6j3thAy3',
  3: 'jQkwEYOZ',
  6: 'AarDEzND',
  9: 'UZKHXO9v',
  12: 'lMkmjFxk',
};

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

/** Xsolla recurring plan external id (`purchase.subscription.plan_id`) → billing period length. */
const PLAN_EXTERNAL_ID_TO_MONTHS = new Map<string, TufStellarMonths>(
  (Object.entries(MONTH_TO_PLAN_ID) as [string, string][]).map(([monthsKey, planId]) => [
    planId,
    Number(monthsKey) as TufStellarMonths,
  ]),
);

export function isTufStellarMonths(value: number): value is TufStellarMonths {
  return (TUF_STELLAR_ALLOWED_MONTHS as readonly number[]).includes(value);
}

export function resolveTufStellarProductId(months: number): string | null {
  if (!isTufStellarMonths(months)) return null;
  return MONTH_TO_PLAN_ID[months];
}

export function resolveTufStellarGiftProductId(months: number): string | null {
  if (!isTufStellarMonths(months)) return null;
  return MONTH_TO_GIFT_PRODUCT_ID[months];
}

/** Resolve gift SKU from webhook purchase payload (external id / sku string). */
export function monthsFromTufStellarGiftProductId(sku: string | null | undefined): TufStellarMonths | null {
  if (sku == null || sku === '') return null;
  const m = GIFT_PRODUCT_ID_TO_MONTHS.get(String(sku).trim());
  return m ?? null;
}

export function monthsFromTufStellarPlanExternalId(planExternalId: string | null | undefined): TufStellarMonths | null {
  if (planExternalId == null || planExternalId === '') return null;
  const m = PLAN_EXTERNAL_ID_TO_MONTHS.get(String(planExternalId).trim());
  return m ?? null;
}

/** Primary recurring plan id on subscription payment / lifecycle webhooks. */
export function extractTufStellarPlanExternalIdFromXsollaPayload(payload: unknown): string | null {
  const p = payload as Record<string, unknown> | null | undefined;
  const purchase = p?.purchase as Record<string, unknown> | undefined;
  const subs = (purchase?.subscription ?? p?.subscription) as Record<string, unknown> | undefined;
  const planObj = subs?.plan as Record<string, unknown> | undefined;
  const candidates: unknown[] = [
    subs?.plan_id,
    subs?.planId,
    planObj?.external_id,
    planObj?.externalId,
    planObj?.id,
  ];
  for (const c of candidates) {
    if (c != null && String(c).trim() !== '') return String(c).trim();
  }
  return null;
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
    payload?.purchase?.subscription?.product_id,
    payload?.purchase?.subscription?.productId,
    payload?.purchase?.subscription?.sku,
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