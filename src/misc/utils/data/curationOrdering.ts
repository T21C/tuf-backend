import type Curation from '@/models/curations/Curation.js';
import type CurationType from '@/models/curations/CurationType.js';
import { curationTypeAbilities } from '@/config/constants.js';
import { hasAnyAbility } from '@/misc/utils/data/curationTypeUtils.js';

const THEME_ABILITIES = [curationTypeAbilities.CUSTOM_CSS, curationTypeAbilities.CUSTOM_COLOR_THEME];

function plainTypeHasThemeAbility(type: { abilities?: string | number | bigint } | null | undefined): boolean {
  if (type?.abilities === undefined || type.abilities === null) return false;
  const a = BigInt(String(type.abilities));
  return THEME_ABILITIES.some((ab) => (a & ab) === ab);
}

function typeGroupOrder(t: CurationType | null | undefined): number {
  return t?.groupSortOrder ?? 0;
}

function typeSortOrder(t: CurationType | null | undefined): number {
  return t?.sortOrder ?? 0;
}

function typeIdNum(t: CurationType | null | undefined): number {
  return t?.id ?? 0;
}

/**
 * Sort curation types for display (badges, theme pick): group, sort order, id.
 */
export function sortCurationTypesByOrder(types: CurationType[]): CurationType[] {
  return [...types].sort((a, b) => {
    const g = typeGroupOrder(a) - typeGroupOrder(b);
    if (g !== 0) return g;
    const s = typeSortOrder(a) - typeSortOrder(b);
    if (s !== 0) return s;
    return typeIdNum(a) - typeIdNum(b);
  });
}

/**
 * Use sortCurationTypesByOrder on curation.types; kept for transitional calls.
 */
export function sortCurationsByTypeOrder<T extends { id: number; types?: CurationType[] | null }>(
  curations: T[]
): T[] {
  return [...curations].sort((a, b) => {
    const ta = a.types?.[0];
    const tb = b.types?.[0];
    const g = typeGroupOrder(ta) - typeGroupOrder(tb);
    if (g !== 0) return g;
    const s = typeSortOrder(ta) - typeSortOrder(tb);
    if (s !== 0) return s;
    const tid = typeIdNum(ta) - typeIdNum(tb);
    if (tid !== 0) return tid;
    return a.id - b.id;
  });
}

/**
 * Theme type for ES/API `curation.type` alias (first type with theme abilities, else first sorted).
 */
export function pickThemeTypeForCuration(curation: Curation | null | undefined): CurationType | null {
  if (!curation?.types?.length) return null;
  const sortedTypes = sortCurationTypesByOrder(curation.types as CurationType[]);
  for (const t of sortedTypes) {
    if (hasAnyAbility(t, THEME_ABILITIES)) {
      return t;
    }
  }
  return sortedTypes[0] ?? null;
}

/**
 * One curation per level: first row (max one), used with pickThemeTypeForCuration for `type` alias.
 */
export function pickThemeCuration(curations: Curation[]): Curation | null {
  return curations[0] ?? null;
}

/** Plain JSON curations (e.g. after toJSON) for attaching `curation` theme alias */
export function pickThemeCurationPlain(
  curations: Array<{
    id: number;
    types?: Array<{ abilities?: string | number | bigint; groupSortOrder?: number; sortOrder?: number; id?: number }> | null;
  }>
): (typeof curations)[0] | null {
  const c = curations[0] ?? null;
  if (!c || !c.types?.length) return c;
  const sorted = [...c.types].sort((a, b) => {
    const g = (a.groupSortOrder ?? 0) - (b.groupSortOrder ?? 0);
    if (g !== 0) return g;
    const s = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    if (s !== 0) return s;
    return (a.id ?? 0) - (b.id ?? 0);
  });
  for (const t of sorted) {
    if (plainTypeHasThemeAbility(t)) {
      return c;
    }
  }
  return c;
}

/** API/ES JSON: `types` array + legacy `type` theme alias */
export function serializeCurationJson(curation: Curation): Record<string, unknown> {
  const typesSorted = sortCurationTypesByOrder((curation.types || []) as CurationType[]);
  const typesJson = typesSorted.map((t) => ({
    ...t.toJSON(),
    abilities: (t.abilities as bigint).toString(),
  }));
  const theme = pickThemeTypeForCuration(curation);
  const plain = curation.toJSON() as unknown as Record<string, unknown>;
  return {
    ...plain,
    types: typesJson,
    type: theme
      ? {
          ...theme.toJSON(),
          abilities: (theme.abilities as bigint).toString(),
        }
      : null,
  };
}

export function enrichLevelCurationAliases(level: Record<string, unknown> | null | undefined): void {
  if (!level) return;
  const curations = level.curations;
  if (!Array.isArray(curations) || curations.length === 0) {
    level.curation = null;
    return;
  }
  const sorted = sortCurationsByTypeOrder(curations as Parameters<typeof sortCurationsByTypeOrder>[0]);
  level.curations = sorted;
  const theme = pickThemeCurationPlain(sorted);
  if (theme && Array.isArray(theme.types) && theme.types.length > 0) {
    const st = [...theme.types].sort((a, b) => {
      const g = (a.groupSortOrder ?? 0) - (b.groupSortOrder ?? 0);
      if (g !== 0) return g;
      const s = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
      if (s !== 0) return s;
      return (a.id ?? 0) - (b.id ?? 0);
    });
    const ty = st.find((t) => plainTypeHasThemeAbility(t)) ?? st[0];
    (theme as Record<string, unknown>).type = ty;
  }
  level.curation = theme;
}
