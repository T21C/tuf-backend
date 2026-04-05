import { Op, QueryTypes } from 'sequelize';
import sequelize from '@/config/db.js';
import type { FacetAdvanced, FacetDomain, FacetSimple } from '@/misc/utils/search/facetQuery.js';

async function levelIdsWithAnyTypeIds(typeIds: number[]): Promise<Set<number>> {
  if (typeIds.length === 0) return new Set();
  const rows = await sequelize.query<{ levelId: number }>(
    `SELECT DISTINCT c.levelId FROM curations c
     INNER JOIN curation_curation_types cct ON cct.curationId = c.id
     WHERE cct.typeId IN (:typeIds)`,
    { replacements: { typeIds }, type: QueryTypes.SELECT }
  );
  return new Set(rows.map((r) => r.levelId));
}

async function levelIdsWithAllTypeIds(typeIds: number[]): Promise<Set<number>> {
  if (typeIds.length === 0) return new Set();
  const n = typeIds.length;
  const rows = await sequelize.query<{ levelId: number }>(
    `SELECT c.levelId FROM curations c
     INNER JOIN curation_curation_types cct ON cct.curationId = c.id
     WHERE cct.typeId IN (:typeIds)
     GROUP BY c.levelId
     HAVING COUNT(DISTINCT cct.typeId) = :n`,
    { replacements: { typeIds, n }, type: QueryTypes.SELECT }
  );
  return new Set(rows.map((r) => r.levelId));
}

function intersectSets(a: Set<number>, b: Set<number>): Set<number> {
  return new Set([...a].filter((x) => b.has(x)));
}

function unionSets(sets: Set<number>[]): Set<number> {
  const u = new Set<number>();
  for (const s of sets) for (const x of s) u.add(x);
  return u;
}

/**
 * Resolves curation-type facet domain to level IDs for admin / SQL filters.
 * @returns null = no constraint (all levels), empty Set = impossible match
 */
export async function levelIdsForCurationFacetDomain(
  domain: FacetDomain
): Promise<Set<number> | null> {
  if (domain.mode === 'simple') {
    const s = domain as FacetSimple;
    if (s.ids.length === 0) return null;
    if (s.op === 'or') {
      return levelIdsWithAnyTypeIds(s.ids);
    }
    return levelIdsWithAllTypeIds(s.ids);
  }

  const d = domain as FacetAdvanced;
  const groupSets: Set<number>[] = [];

  for (const g of d.groups) {
    if (g.ids.length === 0) continue;
    if (g.quantifier === 'all') {
      groupSets.push(await levelIdsWithAllTypeIds(g.ids));
    } else {
      groupSets.push(await levelIdsWithAnyTypeIds(g.ids));
    }
  }

  const pairs = d.betweenPairs;
  const fb = d.betweenGroups;

  let combined: Set<number> | null = null;
  if (groupSets.length === 0) {
    combined = null;
  } else if (groupSets.length === 1) {
    combined = groupSets[0];
  } else {
    let acc = groupSets[0];
    for (let i = 1; i < groupSets.length; i++) {
      const op = pairs?.[i - 1] ?? fb;
      if (op === 'or') {
        acc = unionSets([acc, groupSets[i]]);
      } else {
        acc = intersectSets(acc, groupSets[i]);
      }
    }
    combined = acc;
  }

  if (d.excludeIds.length > 0) {
    const withExcluded = await levelIdsWithAnyTypeIds(d.excludeIds);
    if (combined === null) {
      const allRows = await sequelize.query<{ levelId: number }>(
        `SELECT DISTINCT levelId FROM curations`,
        { type: QueryTypes.SELECT }
      );
      combined = new Set(allRows.map((r) => r.levelId));
    }
    combined = new Set([...combined].filter((id) => !withExcluded.has(id)));
  }

  return combined;
}

/**
 * Intersect existing Sequelize `where.levelId` with an allowed id set from facet resolution.
 */
export function mergeFacetLevelIds(
  where: Record<string, unknown>,
  allowed: Set<number>
): 'ok' | 'empty' {
  if (allowed.size === 0) return 'empty';

  const ex = where.levelId;
  if (ex === undefined) {
    where.levelId = { [Op.in]: [...allowed] };
    return 'ok';
  }
  if (typeof ex === 'number') {
    if (!allowed.has(ex)) return 'empty';
    return 'ok';
  }
  if (ex && typeof ex === 'object' && !Array.isArray(ex)) {
    const ins = (ex as { [Op.in]?: number[] })[Op.in];
    if (Array.isArray(ins)) {
      const next = ins.filter((id) => allowed.has(id));
      if (next.length === 0) return 'empty';
      where.levelId = { [Op.in]: next };
      return 'ok';
    }
  }
  where.levelId = { [Op.in]: [...allowed] };
  return 'ok';
}
