/**
 * Pure helpers for locating a document inside an Elasticsearch sort.
 * Missing values sort last, matching Elasticsearch's default `missing: _last`.
 */

export type SortOrder = 'asc' | 'desc';

export type SortKey = {
  field: string;
  order: SortOrder;
};

export type SortValue = string | number | boolean | null;

type EsQuery = Record<string, unknown>;

export function sortKeysFromEsSort(sort: readonly unknown[]): SortKey[] {
  return sort.map((clause) => {
    if (!clause || typeof clause !== 'object' || Array.isArray(clause)) {
      throw new Error('Leaderboard sort clause must be an object');
    }
    const field = Object.keys(clause)[0];
    if (!field) throw new Error('Leaderboard sort clause is empty');
    const spec = (clause as Record<string, unknown>)[field];
    if (spec === 'asc' || spec === 'desc') {
      return { field, order: spec };
    }
    if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
      const order = (spec as { order?: unknown }).order;
      return { field, order: order === 'asc' ? 'asc' : 'desc' };
    }
    return { field, order: 'desc' };
  });
}

export function reverseEsSort(sort: readonly unknown[]): unknown[] {
  return sort.map((clause) => {
    if (!clause || typeof clause !== 'object' || Array.isArray(clause)) return clause;
    const field = Object.keys(clause)[0];
    if (!field) return clause;
    const spec = (clause as Record<string, unknown>)[field];
    if (spec === 'asc' || spec === 'desc') {
      return { [field]: spec === 'asc' ? 'desc' : 'asc' };
    }
    if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
      const current = (spec as { order?: unknown }).order === 'asc' ? 'asc' : 'desc';
      return { [field]: { ...spec, order: current === 'asc' ? 'desc' : 'asc' } };
    }
    return clause;
  });
}

function isSortValue(value: unknown): value is SortValue {
  return (
    value == null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

export function normalizeSortValues(raw: unknown): SortValue[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (!raw.every(isSortValue)) return null;
  return raw.map((value) => (value == null ? null : value));
}

function equalClause(field: string, value: SortValue): EsQuery {
  if (value == null) {
    return { bool: { must_not: [{ exists: { field } }] } };
  }
  if (typeof value === 'number') {
    return { range: { [field]: { gte: value, lte: value } } };
  }
  return { term: { [field]: value } };
}

/** Documents that sort strictly before `value` on this key. */
function strictlyBeforeClause(key: SortKey, value: SortValue): EsQuery {
  if (value == null) {
    return { exists: { field: key.field } };
  }
  if (key.order === 'desc') {
    return { range: { [key.field]: { gt: value } } };
  }
  return { range: { [key.field]: { lt: value } } };
}

/**
 * Filter matching documents that sort strictly before `values` under `keys`.
 * Returns null when there is nothing to compare.
 */
export function precedesFilter(keys: readonly SortKey[], values: readonly SortValue[]): EsQuery | null {
  if (keys.length === 0 || keys.length !== values.length) return null;

  const should: EsQuery[] = [];
  for (let depth = 0; depth < keys.length; depth += 1) {
    const filter: EsQuery[] = [];
    for (let earlier = 0; earlier < depth; earlier += 1) {
      filter.push(equalClause(keys[earlier].field, values[earlier]));
    }
    filter.push(strictlyBeforeClause(keys[depth], values[depth]));
    should.push({ bool: { filter } });
  }

  return { bool: { should, minimum_should_match: 1 } };
}
