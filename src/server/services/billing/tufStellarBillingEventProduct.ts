import { inferGiftMonthsFromXsollaPayload, monthsFromTufStellarGiftProductId } from '@/server/services/billing/tufStellarProductCatalog.js';

export type BillingEventProductKind = 'purchase' | 'unknown';

/** Parsed product hints from an Xsolla IPN `rawBody` for billing activity UI. */
export interface BillingEventProductDescriptor {
  kind: BillingEventProductKind;
  /** Resolved term length when SKU matches the TUFStellar catalog. */
  months: number | null;
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
    sku,
    itemId,
  };
}
