export type SiteLanguageConfig = {
  display: string;
  countryCode: string;
  folder: string;
};

export const SITE_LANGUAGE_CONFIGS: Record<string, SiteLanguageConfig> = {
  en: {display: 'English', countryCode: 'us', folder: 'en'},
  pl: {display: 'Polish', countryCode: 'pl', folder: 'pl'},
  kr: {display: '한국어', countryCode: 'kr', folder: 'kr'},
  cn: {display: '中文', countryCode: 'cn', folder: 'cn'},
  id: {display: 'Bahasa Indonesia', countryCode: 'id', folder: 'id'},
  jp: {display: '日本語', countryCode: 'jp', folder: 'jp'},
  ru: {display: 'Русский', countryCode: 'ru', folder: 'ru'},
  de: {display: 'Deutsch', countryCode: 'de', folder: 'de'},
  fr: {display: 'Français', countryCode: 'fr', folder: 'fr'},
  es: {display: 'Español', countryCode: 'es', folder: 'es'},
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
