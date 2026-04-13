/**
 * Small compositional helpers for Elasticsearch query DSL.
 * Keeps leaf shapes identical to hand-written JSON so behavior stays stable.
 */
export type EsQuery = Record<string, unknown>;

export function boolMust(must: EsQuery[]): EsQuery {
  return { bool: { must } };
}

export function boolShould(minimumShouldMatch: number, should: EsQuery[]): EsQuery {
  return { bool: { should, minimum_should_match: minimumShouldMatch } };
}

/** `should` only — omits `minimum_should_match` to match legacy DSL where ES defaults apply. */
export function boolShouldOnly(should: EsQuery[]): EsQuery {
  return { bool: { should } };
}

export function boolMustNot(mustNot: EsQuery[]): EsQuery {
  return { bool: { must_not: mustNot } };
}

export function boolFilter(filter: EsQuery[]): EsQuery {
  return { bool: { filter } };
}

/**
 * Wraps `query` in a nested query. When `ignoreUnmapped` is true, adds ignore_unmapped (for optional nested mappings).
 */
export function nestedQuery(path: string, query: EsQuery, ignoreUnmapped = false): EsQuery {
  const nested: Record<string, unknown> = { path, query };
  if (ignoreUnmapped) {
    nested.ignore_unmapped = true;
  }
  return { nested };
}

export function wildcardCi(field: string, value: string): EsQuery {
  return {
    wildcard: {
      [field]: {
        value,
        case_insensitive: true,
      },
    },
  };
}

export function termField(field: string, value: string | number | boolean, caseInsensitive?: boolean): EsQuery {
  if (caseInsensitive) {
    return {
      term: {
        [field]: {
          value,
          case_insensitive: true,
        },
      },
    };
  }
  return { term: { [field]: value } };
}

export function existsField(field: string): EsQuery {
  return { exists: { field } };
}

export function termsField(field: string, values: (string | number)[]): EsQuery {
  return { terms: { [field]: values } };
}

export function rangeGt(field: string, gt: number): EsQuery {
  return { range: { [field]: { gt } } };
}

export function wrapMustNot(q: EsQuery): EsQuery {
  return { bool: { must_not: [q] } };
}

export function maybeNot(isNot: boolean, q: EsQuery): EsQuery {
  return isNot ? wrapMustNot(q) : q;
}

export function matchNone(): EsQuery {
  return { bool: { must_not: [{ match_all: {} }] } };
}
