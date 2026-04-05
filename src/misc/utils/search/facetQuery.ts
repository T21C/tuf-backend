/**
 * Facet query v1: tags and curation types with simple (AND/OR across selection)
 * or advanced (ALL/ANY groups, between-group AND/OR, excludes).
 */

export const FACET_QUERY_MAX_IDS_PER_GROUP = 100;
export const FACET_QUERY_MAX_GROUPS = 20;
export const FACET_QUERY_MAX_TOTAL_IDS = 500;

export type FacetSimpleOp = 'and' | 'or';

export interface FacetSimple {
  mode: 'simple';
  op: FacetSimpleOp;
  ids: number[];
}

export interface FacetAdvancedGroup {
  quantifier: 'all' | 'any';
  ids: number[];
}

export interface FacetAdvanced {
  mode: 'advanced';
  groups: FacetAdvancedGroup[];
  /** Uniform operator between all groups (legacy; used if betweenPairs omitted) */
  betweenGroups: 'and' | 'or';
  /** Per gap: connects groups[i] and groups[i+1]; left-associative when combined */
  betweenPairs?: ('and' | 'or')[];
  excludeIds: number[];
}

export type FacetDomain = FacetSimple | FacetAdvanced;

export interface FacetQueryV1 {
  v: 1;
  tags?: FacetDomain;
  curationTypes?: FacetDomain;
  /** How to combine tag subtree with curation-type subtree when both present */
  combine?: 'and' | 'or';
}

function dedupePositiveInts(ids: unknown[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const x of ids) {
    const n = typeof x === 'number' ? x : Number(x);
    if (!Number.isFinite(n) || n <= 0) continue;
    const t = Math.floor(n);
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function validateSimple(raw: Record<string, unknown>): FacetSimple | null {
  if (raw.mode !== 'simple') return null;
  const op = raw.op;
  if (op !== 'and' && op !== 'or') return null;
  if (!Array.isArray(raw.ids)) return null;
  const ids = dedupePositiveInts(raw.ids as unknown[]).slice(0, FACET_QUERY_MAX_IDS_PER_GROUP);
  return { mode: 'simple', op, ids };
}

function validateAdvanced(raw: Record<string, unknown>): FacetAdvanced | null {
  if (raw.mode !== 'advanced') return null;
  const between = raw.betweenGroups;
  if (between !== 'and' && between !== 'or') return null;
  if (!Array.isArray(raw.groups)) return null;
  const groupsIn = raw.groups as unknown[];
  if (groupsIn.length > FACET_QUERY_MAX_GROUPS) return null;

  const groups: FacetAdvancedGroup[] = [];
  for (const g of groupsIn) {
    if (!g || typeof g !== 'object') continue;
    const go = g as Record<string, unknown>;
    const q = go.quantifier;
    if (q !== 'all' && q !== 'any') continue;
    if (!Array.isArray(go.ids)) continue;
    const ids = dedupePositiveInts(go.ids as unknown[]).slice(0, FACET_QUERY_MAX_IDS_PER_GROUP);
    if (ids.length === 0) continue;
    groups.push({ quantifier: q, ids });
  }

  let excludeIds: number[] = [];
  if (Array.isArray(raw.excludeIds)) {
    excludeIds = dedupePositiveInts(raw.excludeIds as unknown[]).slice(0, FACET_QUERY_MAX_IDS_PER_GROUP);
  }

  let betweenPairs: ('and' | 'or')[] | undefined;
  if (Array.isArray(raw.betweenPairs)) {
    const bp = raw.betweenPairs as unknown[];
    if (bp.length !== Math.max(0, groups.length - 1)) return null;
    betweenPairs = [];
    for (const x of bp) {
      if (x !== 'and' && x !== 'or') return null;
      betweenPairs.push(x);
    }
  }

  if (groups.length === 0 && excludeIds.length === 0) return null;
  const out: FacetAdvanced = {
    mode: 'advanced',
    groups,
    betweenGroups: between,
    excludeIds,
  };
  if (betweenPairs && betweenPairs.length > 0) {
    out.betweenPairs = betweenPairs;
  }
  return out;
}

function validateDomain(raw: unknown): FacetDomain | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.mode === 'simple') return validateSimple(o);
  if (o.mode === 'advanced') return validateAdvanced(o);
  return null;
}

/**
 * Parse `facetQuery` query param (JSON string). Returns null if absent or invalid.
 */
export function parseFacetQueryString(raw: string | undefined | null): FacetQueryV1 | null {
  if (raw === undefined || raw === null || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (o.v !== 1) return null;

  let totalIds = 0;
  const countIds = (d: FacetDomain | undefined) => {
    if (!d) return;
    if (d.mode === 'simple') totalIds += d.ids.length;
    else {
      for (const g of d.groups) totalIds += g.ids.length;
      totalIds += d.excludeIds.length;
    }
  };

  const tags = validateDomain(o.tags);
  const curationTypes = validateDomain(o.curationTypes);
  if (!tags && !curationTypes) return null;

  const combine = o.combine;
  const combineOk = combine === undefined || combine === 'and' || combine === 'or';
  if (!combineOk) return null;

  countIds(tags ?? undefined);
  countIds(curationTypes ?? undefined);
  if (totalIds > FACET_QUERY_MAX_TOTAL_IDS) return null;

  return {
    v: 1,
    ...(tags ? { tags } : {}),
    ...(curationTypes ? { curationTypes } : {}),
    ...(combine !== undefined ? { combine: combine as 'and' | 'or' } : {}),
  };
}

function nestedTerm(path: string, field: string, id: number): Record<string, unknown> {
  return {
    nested: {
      path,
      query: {
        term: { [field]: id },
      },
    },
  };
}

/** Build one ES bool clause for tags (path `tags`, field `tags.id`) or curation types (`curations`, `curations.typeIds`). */
export function buildFacetDomainClause(
  domain: FacetDomain,
  nestedPath: string,
  termField: string
): Record<string, unknown> | null {
  if (domain.mode === 'simple') {
    if (domain.ids.length === 0) return null;
    const nests = domain.ids.map((id) => nestedTerm(nestedPath, termField, id));
    if (domain.op === 'or') {
      return {
        bool: {
          should: nests,
          minimum_should_match: 1,
        },
      };
    }
    return { bool: { must: nests } };
  }

  const parts: Record<string, unknown>[] = [];

  for (const g of domain.groups) {
    const nests = g.ids.map((id) => nestedTerm(nestedPath, termField, id));
    if (g.quantifier === 'all') {
      parts.push(nests.length === 1 ? nests[0] : { bool: { must: nests } });
    } else {
      parts.push(
        nests.length === 1
          ? nests[0]
          : {
              bool: {
                should: nests,
                minimum_should_match: 1,
              },
            }
      );
    }
  }

  const adv = domain as FacetAdvanced;
  const pairs = adv.betweenPairs;
  const fallback = adv.betweenGroups;

  let clause: Record<string, unknown> | null = null;
  if (parts.length === 1) {
    clause = parts[0];
  } else if (parts.length > 1) {
    let acc: Record<string, unknown> = parts[0];
    for (let i = 1; i < parts.length; i++) {
      const op = pairs?.[i - 1] ?? fallback;
      if (op === 'or') {
        acc = {
          bool: {
            should: [acc, parts[i]],
            minimum_should_match: 1,
          },
        };
      } else {
        acc = { bool: { must: [acc, parts[i]] } };
      }
    }
    clause = acc;
  }

  const mustNot =
    domain.excludeIds.length > 0
      ? domain.excludeIds.map((id) => nestedTerm(nestedPath, termField, id))
      : [];

  if (clause === null && mustNot.length === 0) return null;
  if (clause === null) {
    return {
      bool: {
        must_not: mustNot,
      },
    };
  }
  if (mustNot.length === 0) return clause;
  return {
    bool: {
      must: [clause],
      must_not: mustNot,
    },
  };
}

/**
 * Combine tag and curation clauses per `combine` (default: and).
 */
export function combineFacetClauses(
  tagClause: Record<string, unknown> | null,
  curationClause: Record<string, unknown> | null,
  combine: 'and' | 'or' | undefined
): Record<string, unknown> | null {
  const op = combine ?? 'and';
  if (tagClause && curationClause) {
    if (op === 'or') {
      return {
        bool: {
          should: [tagClause, curationClause],
          minimum_should_match: 1,
        },
      };
    }
    return { bool: { must: [tagClause, curationClause] } };
  }
  return tagClause ?? curationClause;
}
