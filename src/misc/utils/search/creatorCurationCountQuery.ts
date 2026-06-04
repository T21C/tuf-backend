import {
  parseNumericSearchConstraint,
  type ParsedNumericSearchConstraint,
} from '@/misc/utils/data/searchHelpers.js';
import { resolveCurationTypes } from '@/server/services/elasticsearch/search/tools/esQueryBuilder/filterResolvers.js';
import {
  boolMust,
  boolShould,
  matchNone,
  nestedQuery,
  rangeOnField,
  termField,
  type EsQuery,
} from '@/server/services/elasticsearch/search/tools/esQueryBuilder/esQueryPrimitives.js';

const NESTED_PATH = 'curationTypeCountPairs';
const TYPE_ID_FIELD = 'curationTypeCountPairs.typeId';
const COUNT_FIELD = 'curationTypeCountPairs.count';

export type CreatorCurationCountConstraint = {
  name: string;
  parsed: ParsedNumericSearchConstraint;
};

export type CreatorCurationCountGroup = {
  constraints: CreatorCurationCountConstraint[];
  textParts: string[];
};

export type ParseCreatorCurationCountResult = {
  cleanedText: string;
  groups: CreatorCurationCountGroup[];
  hasCountConstraints: boolean;
};

/**
 * Parse a single token like `C3>3`, `Type>=10`, `C2=2` (curation type name + count constraint).
 */
export function parseCreatorCurationCountToken(
  token: string,
): CreatorCurationCountConstraint | null {
  const t = token.trim();
  if (!t) return null;

  const m = t.match(/^(.*?)(>=|<=|>|<|=)(\d+)$/);
  if (!m) return null;

  const name = m[1].trim();
  if (!name) return null;

  const op = m[2];
  const countStr = m[3];

  if (op === '=') {
    const n = parseInt(countStr, 10);
    if (!Number.isFinite(n)) return null;
    return { name, parsed: { kind: 'term', n } };
  }

  const parsed = parseNumericSearchConstraint(`${op}${countStr}`, { integerOnly: true });
  if (!parsed) return null;
  return { name, parsed };
}

/**
 * Split creator search input into OR groups (|) with AND terms (,),
 * extracting curation count constraints from each term.
 */
export function parseCreatorCurationCountQuery(raw: string): ParseCreatorCurationCountResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { cleanedText: '', groups: [], hasCountConstraints: false };
  }

  const orParts = trimmed.split('|').map((p) => p.trim()).filter((p) => p.length > 0);
  const groups: CreatorCurationCountGroup[] = [];
  const allTextParts: string[] = [];

  for (const orPart of orParts) {
    const terms = orPart
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const constraints: CreatorCurationCountConstraint[] = [];
    const textParts: string[] = [];

    for (const term of terms) {
      const constraint = parseCreatorCurationCountToken(term);
      if (constraint) {
        constraints.push(constraint);
      } else {
        textParts.push(term);
        allTextParts.push(term);
      }
    }

    if (constraints.length > 0 || textParts.length > 0) {
      groups.push({ constraints, textParts });
    }
  }

  const hasCountConstraints = groups.some((g) => g.constraints.length > 0);
  const cleanedText = allTextParts.join(' ').trim();

  return { cleanedText, groups, hasCountConstraints };
}

function nestedCountClause(typeId: number, parsed: ParsedNumericSearchConstraint): EsQuery {
  const must: EsQuery[] = [termField(TYPE_ID_FIELD, typeId)];
  if (parsed.kind === 'term') {
    must.push(termField(COUNT_FIELD, parsed.n));
  } else {
    must.push(rangeOnField(COUNT_FIELD, parsed.bounds));
  }
  return nestedQuery(NESTED_PATH, boolMust(must));
}

function groupToClause(
  group: CreatorCurationCountGroup,
  typeIdByName: Map<string, number>,
): EsQuery | null {
  if (group.constraints.length === 0) return null;

  const clauses: EsQuery[] = [];
  for (const c of group.constraints) {
    const typeId = typeIdByName.get(c.name);
    if (typeId === undefined) {
      return matchNone();
    }
    clauses.push(nestedCountClause(typeId, c.parsed));
  }

  if (clauses.length === 1) return clauses[0];
  return boolMust(clauses);
}

/**
 * Build ES filter clause for manual curation count tokens (OR between | groups, AND between , terms).
 */
export function buildCreatorCurationCountEsClause(
  groups: CreatorCurationCountGroup[],
  typeIdByName: Map<string, number>,
): EsQuery | null {
  const groupClauses = groups
    .map((g) => groupToClause(g, typeIdByName))
    .filter((c): c is EsQuery => c !== null);

  if (groupClauses.length === 0) return null;
  if (groupClauses.length === 1) return groupClauses[0];
  return boolShould(1, groupClauses);
}

/**
 * Resolve all curation type names referenced in parsed groups to a name→id map.
 */
export async function resolveCreatorCurationCountTypeIds(
  groups: CreatorCurationCountGroup[],
): Promise<Map<string, number>> {
  const names = new Set<string>();
  for (const g of groups) {
    for (const c of g.constraints) {
      names.add(c.name);
    }
  }
  if (names.size === 0) return new Map();

  const ids = await resolveCurationTypes([...names]);
  if (ids.length === 0) return new Map();

  const CurationType = (await import('@/models/curations/CurationType.js')).default;
  const { Op } = await import('sequelize');
  const rows = await CurationType.findAll({
    where: { name: { [Op.in]: [...names] }, id: { [Op.in]: ids } },
    attributes: ['id', 'name'],
  });

  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.name, row.id);
  }
  return map;
}

export async function buildCreatorCurationCountFilterFromRaw(
  raw: string,
): Promise<{ cleanedText: string; filter: EsQuery | null; hasCountConstraints: boolean }> {
  const parsed = parseCreatorCurationCountQuery(raw);
  if (!parsed.hasCountConstraints) {
    return {
      cleanedText: parsed.cleanedText || raw.trim(),
      filter: null,
      hasCountConstraints: false,
    };
  }

  const typeIdByName = await resolveCreatorCurationCountTypeIds(parsed.groups);
  const filter = buildCreatorCurationCountEsClause(parsed.groups, typeIdByName);

  return {
    cleanedText: parsed.cleanedText,
    filter,
    hasCountConstraints: true,
  };
}
