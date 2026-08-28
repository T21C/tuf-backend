import {DEFAULT_SITE_LANGUAGE} from '@/config/siteLanguages.js';

export type PublishCheckResult = {ok: true} | {ok: false; error: string};

export type PublishCheckLocale = {languageCode: string};

export type PublishCheckLink = {
  title?: string | null;
  url?: string | null;
  locales: PublishCheckLocale[];
};

export type PublishCheckItem = {
  id: number;
  linkId: number | null;
  link: PublishCheckLink | null;
};

export type PublishLocaleDefault = {
  languageCode: string;
  itemId: number;
};

export function localesOnItem(item: PublishCheckItem): string[] {
  return (item.link?.locales ?? []).map((row) => row.languageCode);
}

export function itemHasLocale(item: PublishCheckItem, languageCode: string): boolean {
  return localesOnItem(item).includes(languageCode);
}

export function itemsByLocale(items: PublishCheckItem[]): Map<string, PublishCheckItem[]> {
  const map = new Map<string, PublishCheckItem[]>();
  for (const item of items) {
    for (const code of new Set(localesOnItem(item))) {
      const list = map.get(code) ?? [];
      list.push(item);
      map.set(code, list);
    }
  }
  return map;
}

export function checkPublishReady(
  items: PublishCheckItem[],
  defaults: PublishLocaleDefault[],
): PublishCheckResult {
  for (const item of items) {
    if (!item.linkId || !item.link) continue;
    const hasEn =
      item.link.locales.some((row) => row.languageCode === DEFAULT_SITE_LANGUAGE) ||
      Boolean(item.link.title && item.link.url);
    if (!hasEn) {
      return {ok: false, error: 'Every link must have an English locale before publishing'};
    }
  }
  const byLocale = itemsByLocale(items);
  const defaultByCode = new Map(defaults.map((row) => [row.languageCode, row.itemId]));
  for (const [code, live] of byLocale.entries()) {
    if (live.length < 2) continue;
    const itemId = defaultByCode.get(code);
    if (!itemId || !live.some((item) => item.id === itemId)) {
      return {
        ok: false,
        error: `Select a default ${code} link before publishing`,
      };
    }
  }
  return {ok: true};
}
