import { isTufStellarMonths, type TufStellarMonths } from '@/server/services/billing/tufStellarProductCatalog.js';

/** ISO 4217 codes with a full marketing price row (keep in sync with product spreadsheet). */
export const TUF_STELLAR_DISPLAY_CURRENCIES = [
  'USD',
  'SGD',
  'KRW',
  'JPY',
  'EUR',
  'CNY',
  'BRL',
  'PLN',
  'MYR',
  'GBP',
  'CAD',
  'AUD',
  'THB',
  'PHP',
  'TWD',
  'IDR',
  'HKD',
  'VND',
] as const;

export type TufStellarDisplayCurrency = (typeof TUF_STELLAR_DISPLAY_CURRENCIES)[number];

const DEFAULT_CURRENCY: TufStellarDisplayCurrency = 'USD';

/** Major currency units per term (same source as client-facing marketing table). */
const AMOUNTS_BY_CURRENCY: Record<TufStellarDisplayCurrency, Record<TufStellarMonths, number>> = {
  USD: { 1: 3, 2: 6, 3: 8, 6: 16, 9: 24, 12: 30 },
  SGD: { 1: 4, 2: 8, 3: 11, 6: 22, 9: 33, 12: 40 },
  KRW: { 1: 4500, 2: 9000, 3: 12000, 6: 24000, 9: 36000, 12: 45000 },
  JPY: { 1: 450, 2: 900, 3: 1200, 6: 2400, 9: 3600, 12: 4500 },
  EUR: { 1: 2.8, 2: 5.5, 3: 7.5, 6: 15, 9: 22, 12: 28 },
  CNY: { 1: 20, 2: 40, 3: 54, 6: 108, 9: 162, 12: 200 },
  BRL: { 1: 15, 2: 30, 3: 40, 6: 80, 9: 120, 12: 150 },
  PLN: { 1: 11, 2: 22, 3: 30, 6: 60, 9: 90, 12: 110 },
  MYR: { 1: 12, 2: 24, 3: 32, 6: 64, 9: 96, 12: 120 },
  GBP: { 1: 2.5, 2: 5, 3: 6.5, 6: 13, 9: 19, 12: 24 },
  CAD: { 1: 4, 2: 8, 3: 11, 6: 22, 9: 33, 12: 40 },
  AUD: { 1: 4, 2: 8, 3: 11, 6: 22, 9: 33, 12: 40 },
  THB: { 1: 100, 2: 200, 3: 270, 6: 540, 9: 810, 12: 1000 },
  PHP: { 1: 180, 2: 360, 3: 480, 6: 960, 9: 1440, 12: 1800 },
  TWD: { 1: 95, 2: 190, 3: 255, 6: 510, 9: 765, 12: 950 },
  IDR: { 1: 52000, 2: 104000, 3: 140000, 6: 280000, 9: 420000, 12: 520000 },
  HKD: { 1: 24, 2: 48, 3: 64, 6: 128, 9: 192, 12: 240 },
  VND: { 1: 79000, 2: 158000, 3: 210000, 6: 420000, 9: 630000, 12: 790000 },
};

export type TufStellarPricingAmountsByMonths = Record<'1' | '2' | '3' | '6' | '9' | '12', number>;

function normalizeCurrency(code: string | null | undefined): TufStellarDisplayCurrency {
  const u = String(code ?? '')
    .trim()
    .toUpperCase();
  return (TUF_STELLAR_DISPLAY_CURRENCIES as readonly string[]).includes(u) ? (u as TufStellarDisplayCurrency) : DEFAULT_CURRENCY;
}

/** Bundle list price at the 1-month marketing rate × term length (for save % vs bundle). */
export function listAtSingleMonthRate(months: TufStellarMonths, currency: string): number {
  const cur = normalizeCurrency(currency);
  const one = AMOUNTS_BY_CURRENCY[cur][1];
  return months * one;
}

export function getDisplayAmountMajor(months: number, currency: string): number | null {
  if (!isTufStellarMonths(months)) return null;
  const cur = normalizeCurrency(currency);
  const row = AMOUNTS_BY_CURRENCY[cur];
  return row[months] ?? null;
}

/** Amounts keyed as JSON string keys for client consumption. */
export function buildPricingDisplayAmountsByMonths(currency: string): TufStellarPricingAmountsByMonths {
  const cur = normalizeCurrency(currency);
  const row = AMOUNTS_BY_CURRENCY[cur];
  return {
    '1': row[1],
    '2': row[2],
    '3': row[3],
    '6': row[6],
    '9': row[9],
    '12': row[12],
  };
}

export function defaultDisplayCurrency(): TufStellarDisplayCurrency {
  return DEFAULT_CURRENCY;
}
