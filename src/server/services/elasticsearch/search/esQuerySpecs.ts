import {
  type EsQuery,
  boolShould,
  nestedQuery,
  wildcardCi,
} from '@/server/services/elasticsearch/search/esQueryPrimitives.js';

/**
 * Declarative: one nested document with a primary text field plus an optional nested aliases path.
 * Matches the repeated pattern used for songObject, primaryArtist, artists.*, teamObject, etc.
 */
export function specNestedDocNameWithOptionalAliases(opts: {
  rootNestedPath: string;
  nameField: string;
  aliasNestedPath: string;
  aliasField: string;
  wildcardValue: string;
  excludeAliases: boolean;
  ignoreUnmapped?: boolean;
}): EsQuery {
  const ignore = opts.ignoreUnmapped ?? false;
  const shouldClauses: EsQuery[] = [wildcardCi(opts.nameField, opts.wildcardValue)];
  if (!opts.excludeAliases) {
    shouldClauses.push(
      nestedQuery(
        opts.aliasNestedPath,
        wildcardCi(opts.aliasField, opts.wildcardValue),
        ignore,
      ),
    );
  }
  return nestedQuery(opts.rootNestedPath, boolShould(1, shouldClauses), ignore);
}
