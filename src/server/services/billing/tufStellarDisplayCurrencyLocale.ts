import {
  isConfiguredSiteLanguage,
  normalizeSiteLanguage,
  siteLanguageForCountry,
  SITE_LANGUAGE_CONFIGS,
} from '@/config/siteLanguages.js';

/**
 * ISO 4217 checkout currency for a country. Keep values on the display-price allowlist.
 * Unlisted countries fall back to USD.
 */
const COUNTRY_TO_CURRENCY: Record<string, string> = {
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

const DEFAULT_CURRENCY = 'USD';

export type TufStellarDisplayCurrencyPreference = {
  /** Explicit site language. Null or omitted means “follow country”. */
  appLanguage?: string | null;
  /** Player profile country (ISO 3166-1 alpha-2). */
  playerCountry?: string | null;
};

export type BillingDisplayCurrencyInput = TufStellarDisplayCurrencyPreference & {
  /** Cloudflare `CF-IPCountry` when neither language nor player country applies. */
  geoCountry?: string | null;
};

export function usableCountryAlpha2(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const country = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return null;
  if (country === 'XX' || country === 'T1') return null;
  return country;
}

/** Flag country for an explicit site language. Empty when language follows country. */
export function countryForExplicitSiteLanguage(language: unknown): string | null {
  if (typeof language !== 'string' || language.trim() === '') return null;
  const code = normalizeSiteLanguage(language);
  if (!isConfiguredSiteLanguage(code)) return null;
  return usableCountryAlpha2(SITE_LANGUAGE_CONFIGS[code]?.countryCode);
}

/**
 * Country that picks the default TUFStellar currency.
 * An explicit language wins. Otherwise a usable player country.
 * With no country, use the language Follow country would show. Geo is last.
 */
export function resolveBillingDisplayCountry(input: BillingDisplayCurrencyInput): string | null {
  const fromLanguage = countryForExplicitSiteLanguage(input.appLanguage);
  if (fromLanguage) return fromLanguage;
  const fromPlayer = usableCountryAlpha2(input.playerCountry);
  if (fromPlayer) return fromPlayer;
  const implied = countryForExplicitSiteLanguage(siteLanguageForCountry(input.playerCountry));
  if (implied) return implied;
  return usableCountryAlpha2(input.geoCountry);
}

export function displayCurrencyCodeFromCountry(country: string | null | undefined): string {
  const code = usableCountryAlpha2(country);
  if (!code) return DEFAULT_CURRENCY;
  if (EUROZONE_ALPHA2.has(code)) return 'EUR';
  return COUNTRY_TO_CURRENCY[code] ?? DEFAULT_CURRENCY;
}

export function resolveBillingDisplayCurrency(input: BillingDisplayCurrencyInput): {
  country: string | null;
  currency: string;
} {
  const country = resolveBillingDisplayCountry(input);
  return {
    country,
    currency: displayCurrencyCodeFromCountry(country),
  };
}
