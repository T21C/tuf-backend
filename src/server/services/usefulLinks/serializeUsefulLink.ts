import type UsefulLink from '@/models/misc/UsefulLink.js';
import type UsefulLinkLocale from '@/models/misc/UsefulLinkLocale.js';
import {DEFAULT_SITE_LANGUAGE, normalizeSiteLanguage} from '@/config/siteLanguages.js';

export type UsefulLinkLocaleJson = {
  languageCode: string;
  title: string;
  url: string;
  description: string | null;
};

export type UsefulLinkJson = {
  id: number;
  title: string;
  url: string;
  description: string | null;
  sortWeight: number;
  groupIds: number[];
  locales: UsefulLinkLocaleJson[];
  createdAt: Date;
  updatedAt: Date;
};

type LinkWithRelations = UsefulLink & {
  locales?: UsefulLinkLocale[];
  groups?: {id: number}[];
  groupAssignments?: {groupId: number}[];
};

export function serializeLocale(row: UsefulLinkLocale): UsefulLinkLocaleJson {
  return {
    languageCode: row.languageCode,
    title: row.title,
    url: row.url,
    description: row.description ?? null,
  };
}

export function resolveLinkLocale(
  locales: UsefulLinkLocaleJson[],
  requested: string | null | undefined,
): UsefulLinkLocaleJson | null {
  if (!locales.length) return null;
  const wanted = normalizeSiteLanguage(requested);
  const match = locales.find((row) => row.languageCode === wanted);
  if (match) return match;
  return locales.find((row) => row.languageCode === DEFAULT_SITE_LANGUAGE) ?? locales[0] ?? null;
}

export function linkHasLocale(locales: UsefulLinkLocaleJson[], languageCode: string): boolean {
  const wanted = normalizeSiteLanguage(languageCode);
  return locales.some((row) => row.languageCode === wanted);
}

export function serializeUsefulLink(row: UsefulLink, groupIds?: number[]): UsefulLinkJson {
  const nested = row as LinkWithRelations;
  const locales = [...(nested.locales ?? [])]
    .map(serializeLocale)
    .sort((a, b) => {
      if (a.languageCode === DEFAULT_SITE_LANGUAGE) return -1;
      if (b.languageCode === DEFAULT_SITE_LANGUAGE) return 1;
      return a.languageCode.localeCompare(b.languageCode);
    });
  const ids =
    groupIds ??
    nested.groupAssignments?.map((row) => row.groupId) ??
    nested.groups?.map((row) => row.id) ??
    [];

  return {
    id: row.id,
    title: row.title,
    url: row.url,
    description: row.description ?? null,
    sortWeight: row.sortWeight,
    groupIds: [...new Set(ids)],
    locales,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function compareSerializedLinkOrder(a: UsefulLinkJson, b: UsefulLinkJson): number {
  const sortA = a.sortWeight ?? 0;
  const sortB = b.sortWeight ?? 0;
  if (sortA !== sortB) return sortA - sortB;
  return (a.id ?? 0) - (b.id ?? 0);
}
