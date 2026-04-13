import {
  type EsQuery,
  boolMust,
  boolShould,
  boolShouldOnly,
  nestedQuery,
  termField,
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

/** Nested `levelCredits.creator` with name + optional `creatorAliases` (min_should 1). */
export function specLevelCreditsCreatorInner(opts: {
  wildcardValue: string;
  excludeAliases: boolean;
}): EsQuery {
  const shouldClauses: EsQuery[] = [
    wildcardCi('levelCredits.creator.name', opts.wildcardValue),
  ];
  if (!opts.excludeAliases) {
    shouldClauses.push(
      nestedQuery(
        'levelCredits.creator.creatorAliases',
        wildcardCi('levelCredits.creator.creatorAliases.name', opts.wildcardValue),
      ),
    );
  }
  return nestedQuery('levelCredits.creator', boolShould(1, shouldClauses));
}

/** `levelCredits` nested: creator name/aliases + optional role term (charter/vfxer). */
export function specLevelCreditsByCreatorRole(opts: {
  wildcardValue: string;
  excludeAliases: boolean;
  role?: 'charter' | 'vfxer';
}): EsQuery {
  const mustParts: EsQuery[] = [specLevelCreditsCreatorInner(opts)];
  if (opts.role) {
    mustParts.push(termField('levelCredits.role', opts.role, true));
  }
  return nestedQuery('levelCredits', boolMust(mustParts));
}

/**
 * `field === 'any'`: double-nested credits/creator; inner creator bool is `should` only (legacy shape).
 */
export function specAnyLevelCreditsCreator(opts: { wildcardValue: string; excludeAliases: boolean }): EsQuery {
  const innerShould: EsQuery[] = [
    wildcardCi('levelCredits.creator.name', opts.wildcardValue),
  ];
  if (!opts.excludeAliases) {
    innerShould.push(
      nestedQuery(
        'levelCredits.creator.creatorAliases',
        wildcardCi('levelCredits.creator.creatorAliases.name', opts.wildcardValue),
      ),
    );
  }
  return nestedQuery(
    'levelCredits',
    nestedQuery('levelCredits.creator', boolShouldOnly(innerShould)),
  );
}

/** Single-field `team`: outer + `teamObject` inner use `should` only (no explicit min_should). */
export function specTeamFieldSearch(opts: { wildcardValue: string; excludeAliases: boolean }): EsQuery {
  const teamObjectInner = opts.excludeAliases
    ? boolShouldOnly([wildcardCi('teamObject.name', opts.wildcardValue)])
    : boolShouldOnly([
        wildcardCi('teamObject.name', opts.wildcardValue),
        nestedQuery('teamObject.aliases', wildcardCi('teamObject.aliases.name', opts.wildcardValue)),
      ]);
  return boolShouldOnly([
    wildcardCi('team', opts.wildcardValue),
    nestedQuery('teamObject', teamObjectInner),
  ]);
}

/** `field === 'any'`: `teamObject` nested with explicit `minimum_should_match: 1`. */
export function specAnyTeamObjectWithAliases(opts: {
  wildcardValue: string;
  excludeAliases: boolean;
}): EsQuery {
  const innerShould: EsQuery[] = [wildcardCi('teamObject.name', opts.wildcardValue)];
  if (!opts.excludeAliases) {
    innerShould.push(
      nestedQuery('teamObject.aliases', wildcardCi('teamObject.aliases.name', opts.wildcardValue)),
    );
  }
  return nestedQuery('teamObject', boolShould(1, innerShould));
}
