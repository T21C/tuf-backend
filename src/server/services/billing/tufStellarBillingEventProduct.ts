import { inferGiftMonthsFromXsollaPayload, isTufStellarMonths, monthsFromTufStellarGiftProductId } from '@/server/services/billing/tufStellarProductCatalog.js';

export type BillingEventProductKind = 'purchase' | 'admin_grant' | 'unknown';

/** Parsed product hints from an Xsolla IPN `rawBody` for billing activity UI. */
export interface BillingEventProductDescriptor {
  kind: BillingEventProductKind;
  /** Resolved term length when SKU matches the TUFStellar catalog. */
  months: number | null;
  /** Custom-day admin grants. */
  days: number | null;
  /** SKU / product slug from the webhook when present. */
  sku: string | null;
  /** Purchase line item id from Xsolla when present. */
  itemId: string | null;
}

function extractCustomParameters(payload: Record<string, unknown>): Record<string, unknown> {
  const cp =
    (payload?.custom_parameters as Record<string, unknown> | undefined) ??
    (payload?.customParameters as Record<string, unknown> | undefined) ??
    (payload?.settings as Record<string, unknown> | undefined)?.custom_parameters ??
    (payload?.notification as Record<string, unknown> | undefined)?.custom_parameters;
  if (cp && typeof cp === 'object' && !Array.isArray(cp)) return cp as Record<string, unknown>;
  return {};
}

function trimmed(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  return s.length > 0 ? s : null;
}

function purchaseRoot(payload: Record<string, unknown>): Record<string, unknown> | null {
  const top = payload?.purchase;
  if (top && typeof top === 'object' && !Array.isArray(top)) return top as Record<string, unknown>;
  const notif = payload?.notification as Record<string, unknown> | undefined;
  const nested = notif?.purchase;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested as Record<string, unknown>;
  const billing = payload?.billing as Record<string, unknown> | undefined;
  const billPurchase = billing?.purchase;
  if (billPurchase && typeof billPurchase === 'object' && !Array.isArray(billPurchase)) {
    return billPurchase as Record<string, unknown>;
  }
  return null;
}

/** `order_paid` often sends `items` on the payload root; payment IPNs use `purchase.items`. */
function firstPurchaseItem(payload: Record<string, unknown>): Record<string, unknown> | null {
  const rootItems = payload?.items;
  if (Array.isArray(rootItems) && rootItems.length > 0) {
    const it = rootItems[0];
    if (it != null && typeof it === 'object' && !Array.isArray(it)) return it as Record<string, unknown>;
  }
  const purchase = purchaseRoot(payload);
  const items = purchase?.items;
  if (!Array.isArray(items) || items.length === 0) return null;
  const it = items[0];
  return it != null && typeof it === 'object' && !Array.isArray(it) ? (it as Record<string, unknown>) : null;
}

function skuFromPurchaseItem(item: Record<string, unknown>): string | null {
  return (
    trimmed(item.sku ?? item.product_sku ?? item.productSku) ??
    trimmed(item.product_id ?? item.productId ?? item.external_id ?? item.externalId)
  );
}

function itemIdFromPurchaseItem(item: Record<string, unknown>): string | null {
  return trimmed(item.id ?? item.item_id ?? item.itemId);
}

/**
 * Best-effort descriptor for activity/history: maps webhook line items + SKU fields to catalog months (one-time purchases).
 */
export function describeProductFromXsollaWebhookRawBody(rawBody: string): BillingEventProductDescriptor | null {
  let payload: Record<string, unknown>;
  try {
    const p = JSON.parse(rawBody) as unknown;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    payload = p as Record<string, unknown>;
  } catch {
    return null;
  }

  const purchaseItem = firstPurchaseItem(payload);
  let sku: string | null = purchaseItem ? skuFromPurchaseItem(purchaseItem) : null;
  const itemId: string | null = purchaseItem ? itemIdFromPurchaseItem(purchaseItem) : null;

  if (!sku) {
    const purchase = payload?.purchase as Record<string, unknown> | undefined;
    sku = trimmed(purchase?.sku) ?? null;
  }

  const giftMonthsFromSku = sku ? monthsFromTufStellarGiftProductId(sku) : null;
  const giftMonthsInferred = inferGiftMonthsFromXsollaPayload(payload);

  let kind: BillingEventProductKind = 'unknown';
  let months: number | null = null;

  if (giftMonthsFromSku != null || giftMonthsInferred != null) {
    kind = 'purchase';
    months = giftMonthsFromSku ?? giftMonthsInferred ?? null;
  }

  const hasSignal = sku != null || itemId != null || months != null || kind !== 'unknown';
  if (!hasSignal) return null;

  return {
    kind,
    months,
    days: null,
    sku,
    itemId,
  };
}

/** Parsed product hints from an admin grant billing event `rawBody`. */
export function describeProductFromAdminGrantRawBody(rawBody: string): BillingEventProductDescriptor | null {
  try {
    const p = JSON.parse(rawBody) as unknown;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    const payload = p as Record<string, unknown>;
    if (payload.type !== 'admin_grant') return null;
    const durationKind = payload.durationKind;
    const durationValue = Number(payload.durationValue);
    if (!Number.isFinite(durationValue) || durationValue <= 0) return null;
    if (durationKind === 'months') {
      return {
        kind: 'admin_grant',
        months: durationValue,
        days: null,
        sku: null,
        itemId: null,
      };
    }
    if (durationKind === 'days') {
      return {
        kind: 'admin_grant',
        months: null,
        days: durationValue,
        sku: null,
        itemId: null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Parsed product hints from a Stripe webhook `rawBody` (envelope JSON) for billing activity UI. */
export function describeProductFromStripeWebhookRawBody(rawBody: string): BillingEventProductDescriptor | null {
  let payload: Record<string, unknown>;
  try {
    const p = JSON.parse(rawBody) as unknown;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    payload = p as Record<string, unknown>;
  } catch {
    return null;
  }

  const t = trimmed(payload.type);
  if (t !== 'checkout.session.completed') return null;

  const data = payload.data as Record<string, unknown> | undefined;
  const session = data?.object as Record<string, unknown> | undefined;
  if (!session || String(session.object) !== 'checkout.session') return null;

  const md = (session.metadata as Record<string, unknown> | undefined) ?? {};
  const mRaw = md.tuf_months ?? md.tufMonths;
  const m = mRaw != null && mRaw !== '' ? Number(mRaw) : NaN;
  const months = Number.isFinite(m) && isTufStellarMonths(m) ? m : null;

  const liRoot = session.line_items as { data?: unknown[] } | undefined;
  const firstLi =
    Array.isArray(liRoot?.data) && liRoot!.data!.length > 0 && typeof liRoot!.data![0] === 'object'
      ? (liRoot!.data![0] as Record<string, unknown>)
      : null;
  let itemId: string | null = null;
  if (firstLi) {
    const price = firstLi.price;
    if (typeof price === 'string') itemId = trimmed(price);
    else if (price && typeof price === 'object' && 'id' in price) itemId = trimmed((price as { id: unknown }).id);
  }

  const kind: BillingEventProductKind = months != null ? 'purchase' : 'unknown';
  if (months == null && itemId == null) return null;

  return {
    kind,
    months,
    days: null,
    sku: null,
    itemId,
  };
}
