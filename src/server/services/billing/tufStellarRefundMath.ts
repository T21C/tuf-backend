/**
 * List-rate USD per calendar month used when refunding an in-use segment (consumption priced at the 1-month tier).
 * Keep in sync with client `TUF_STELLAR_TERM_OPTIONS[0].priceUsd` in `client/.../BillingPage/billingUtils.js`.
 */
export const TUF_STELLAR_LIST_USD_PER_MONTH = 3;

/**
 * Linear "gas tank" consumption in purchased month-units over [startsAt, endsAt].
 * Returns a value in [0, months].
 */
export function consumedMonthEquivalent(startMs: number, endMs: number, months: number, nowMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || !Number.isFinite(months) || months <= 0) return 0;
  const span = endMs - startMs;
  const elapsed = Math.min(Math.max(0, nowMs - startMs), span);
  return (elapsed / span) * months;
}

/** List-rate charge in cents (rounded to nearest cent). */
export function listChargeCentsFromConsumedMonthEquiv(consumedMonthEquiv: number, listUsdPerMonth: number): number {
  if (!Number.isFinite(consumedMonthEquiv) || consumedMonthEquiv <= 0) return 0;
  if (!Number.isFinite(listUsdPerMonth) || listUsdPerMonth <= 0) return 0;
  const raw = consumedMonthEquiv * listUsdPerMonth * 100;
  return Math.round(raw);
}

export function computeInUseRefundCents(paidCents: number, refundableCents: number, consumedMonthEquiv: number, listUsdPerMonth: number): number {
  const listCharge = listChargeCentsFromConsumedMonthEquiv(consumedMonthEquiv, listUsdPerMonth);
  const raw = paidCents - listCharge;
  const capped = Math.min(Math.max(0, raw), Math.max(0, refundableCents));
  return Math.floor(capped);
}
