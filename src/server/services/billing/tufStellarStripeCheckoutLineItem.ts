import type { Request } from 'express';
import type Stripe from 'stripe';
import {
  getDisplayAmountMajor,
  TUF_STELLAR_DISPLAY_CURRENCIES,
  type TufStellarDisplayCurrency,
} from '@/server/services/billing/tufStellarDisplayPriceMatrix.js';
import { buildBillingPricingDisplayForRequest } from '@/server/services/billing/tufStellarDisplayPricingRegion.js';
import {
  isTufStellarMonths,
  resolveTufStellarGiftProductId,
  type TufStellarMonths,
} from '@/server/services/billing/tufStellarProductCatalog.js';

export { TUF_STELLAR_DISPLAY_CURRENCIES };

const ZERO_DECIMAL_CURRENCIES = new Set<string>(['JPY', 'KRW', 'VND']);

export type CheckoutCurrencyResolution =
  | { ok: true; currency: TufStellarDisplayCurrency }
  | { ok: false; code: 'INVALID_CHECKOUT_CURRENCY' };

function isAllowlistedCurrency(code: string): code is TufStellarDisplayCurrency {
  return (TUF_STELLAR_DISPLAY_CURRENCIES as readonly string[]).includes(code);
}

/** Resolve checkout currency from request body (`auto`/omit → geo) or explicit ISO code. */
export function resolveCheckoutCurrency(req: Request, bodyCurrency: unknown): CheckoutCurrencyResolution {
  const raw =
    bodyCurrency == null || bodyCurrency === ''
      ? 'auto'
      : String(bodyCurrency).trim().toLowerCase();

  if (raw === 'auto') {
    const { currency } = buildBillingPricingDisplayForRequest(req);
    return { ok: true, currency };
  }

  const code = raw.toUpperCase();
  if (!isAllowlistedCurrency(code)) {
    return { ok: false, code: 'INVALID_CHECKOUT_CURRENCY' };
  }
  return { ok: true, currency: code };
}

/** Convert marketing major units to Stripe `unit_amount` minor units. */
export function majorToStripeUnitAmount(major: number, currency: TufStellarDisplayCurrency): number {
  const cur = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(cur)) {
    return Math.round(major);
  }
  return Math.round(major * 100);
}

function checkoutProductName(months: TufStellarMonths): string {
  const sku = resolveTufStellarGiftProductId(months);
  if (sku) return sku.replace(/_/g, ' ');
  return `TUFStellar — ${months} month${months === 1 ? '' : 's'}`;
}

export type TufStellarCheckoutLineItemResult =
  | { ok: true; lineItem: Stripe.Checkout.SessionCreateParams.LineItem; currency: TufStellarDisplayCurrency; unitAmount: number }
  | { ok: false; code: 'INVALID_CHECKOUT_AMOUNT' };

/** Build a Stripe Checkout `line_items` entry from the marketing price matrix. */
export function buildTufStellarCheckoutLineItem(
  months: number,
  currency: TufStellarDisplayCurrency,
): TufStellarCheckoutLineItemResult {
  if (!isTufStellarMonths(months)) {
    return { ok: false, code: 'INVALID_CHECKOUT_AMOUNT' };
  }

  const major = getDisplayAmountMajor(months, currency);
  if (major == null || !Number.isFinite(major) || major <= 0) {
    return { ok: false, code: 'INVALID_CHECKOUT_AMOUNT' };
  }

  const unitAmount = majorToStripeUnitAmount(major, currency);
  if (unitAmount <= 0) {
    return { ok: false, code: 'INVALID_CHECKOUT_AMOUNT' };
  }

  return {
    ok: true,
    currency,
    unitAmount,
    lineItem: {
      quantity: 1,
      price_data: {
        currency: currency.toLowerCase(),
        unit_amount: unitAmount,
        product_data: {
          name: checkoutProductName(months),
        },
      },
    },
  };
}
