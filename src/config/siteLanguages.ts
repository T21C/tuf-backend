export type SiteLanguageConfig = {
  display: string;
  countryCode: string;
  folder: string;
  /**
   * ISO 3166-1 alpha-2 countries this language is suggested for.
   * When omitted, the language claims only `countryCode` (the flag country).
   */
  countries?: string[];
};

export const SITE_LANGUAGE_CONFIGS: Record<string, SiteLanguageConfig> = {
  en: {display: 'English', countryCode: 'us', folder: 'en'},
  pl: {display: 'Polish', countryCode: 'pl', folder: 'pl'},
  kr: {display: '한국어', countryCode: 'kr', folder: 'kr', countries: ['kr', 'kp']},
  cn: {
    display: '中文',
    countryCode: 'cn',
    folder: 'cn',
    countries: ['cn', 'tw', 'hk', 'mo'],
  },
  id: {display: 'Bahasa Indonesia', countryCode: 'id', folder: 'id'},
  jp: {display: '日本語', countryCode: 'jp', folder: 'jp'},
  ru: {display: 'Русский', countryCode: 'ru', folder: 'ru', countries: ['ru', 'by']},
  de: {
    display: 'Deutsch',
    countryCode: 'de',
    folder: 'de',
    countries: ['de', 'at', 'li', 'ch'],
  },
  fr: {display: 'Français', countryCode: 'fr', folder: 'fr', countries: ['fr', 'mc']},
  es: {
    display: 'Español',
    countryCode: 'es',
    folder: 'es',
    countries: [
      'es',
      'mx',
      'ar',
      'co',
      'cl',
      'pe',
      've',
      'ec',
      'gt',
      'cu',
      'bo',
      'do',
      'hn',
      'py',
      'sv',
      'ni',
      'cr',
      'pa',
      'uy',
      'gq',
      'pr',
    ],
  },
};

/** English names so queries like "Korean" or "French" match native display labels. */
const SITE_LANGUAGE_ENGLISH_NAMES: Record<string, string> = {
  en: 'English',
  pl: 'Polish',
  kr: 'Korean',
  cn: 'Chinese',
  id: 'Indonesian',
  jp: 'Japanese',
  ru: 'Russian',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
};

export const DEFAULT_SITE_LANGUAGE = 'en';

export function claimedCountriesForLanguage(config: SiteLanguageConfig): string[] {
  const raw = config.countries?.length ? config.countries : [config.countryCode];
  return raw
    .map((country) => String(country).trim().toLowerCase())
    .filter(Boolean);
}

function buildCountryToSiteLanguage(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [code, config] of Object.entries(SITE_LANGUAGE_CONFIGS)) {
    for (const country of claimedCountriesForLanguage(config)) {
      const existing = map.get(country);
      if (existing && existing !== code) {
        throw new Error(
          `Country "${country}" is claimed by both "${existing}" and "${code}"`,
        );
      }
      map.set(country, code);
    }
  }
  return map;
}

const COUNTRY_TO_SITE_LANGUAGE = buildCountryToSiteLanguage();

export function siteLanguageForCountry(country: unknown): string {
  if (typeof country !== 'string') return DEFAULT_SITE_LANGUAGE;
  const normalized = country.trim().toLowerCase();
  if (!normalized || normalized === 'xx') return DEFAULT_SITE_LANGUAGE;
  return COUNTRY_TO_SITE_LANGUAGE.get(normalized) ?? DEFAULT_SITE_LANGUAGE;
}

export function normalizeSiteLanguage(code: unknown): string {
  if (typeof code !== 'string') return DEFAULT_SITE_LANGUAGE;
  const trimmed = code.trim().toLowerCase();
  if (!trimmed) return DEFAULT_SITE_LANGUAGE;
  if (trimmed === 'us') return DEFAULT_SITE_LANGUAGE;
  return trimmed;
}

export function isConfiguredSiteLanguage(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(SITE_LANGUAGE_CONFIGS, code);
}

export function listConfiguredSiteLanguageCodes(): string[] {
  return Object.keys(SITE_LANGUAGE_CONFIGS);
}

export function siteLanguageCodesMatchingQuery(raw: string, exact = false): string[] {
  const needle = raw.trim().toLowerCase();
  if (!needle) return [];
  const matched: string[] = [];
  for (const [code, config] of Object.entries(SITE_LANGUAGE_CONFIGS)) {
    const names = [code, config.display, SITE_LANGUAGE_ENGLISH_NAMES[code] ?? ''];
    const hit = names.some((name) => {
      const normalized = name.toLowerCase();
      if (!normalized) return false;
      return exact ? normalized === needle : normalized.includes(needle);
    });
    if (hit) matched.push(code);
  }
  return matched;
}
