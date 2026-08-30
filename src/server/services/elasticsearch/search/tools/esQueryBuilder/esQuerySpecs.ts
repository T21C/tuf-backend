import {
  type EsQuery,
  boolMust,
  boolShould,
  boolShouldOnly,
  nestedQuery,
  termField,
  wildcardCi,
} from '@/server/services/elasticsearch/search/tools/esQueryBuilder/esQueryPrimitives.js';

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

/** Charter / vfxer only — special thanks is display-only and must not match searches. */
export const CONTRIBUTING_CREDIT_ROLES = ['charter', 'vfxer'] as const;

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

/** Same nested document must be charter or vfxer (excludes specialThanks). */
export function specContributingCreditRoles(): EsQuery {
  return boolShould(
    1,
    CONTRIBUTING_CREDIT_ROLES.map((role) => termField('levelCredits.role', role, true)),
  );
}

/** Profile / visibility: this creator charted or VFXed the level. */
export function specLevelCreditsByCreatorId(creatorId: number | string): EsQuery {
  return nestedQuery(
    'levelCredits',
    boolMust([
      termField('levelCredits.creatorId', creatorId),
      specContributingCreditRoles(),
    ]),
  );
}

/** `levelCredits` nested: creator name/aliases + charter/vfxer (or a specific contributing role). */
export function specLevelCreditsByCreatorRole(opts: {
  wildcardValue: string;
  excludeAliases: boolean;
  role?: 'charter' | 'vfxer';
}): EsQuery {
  const mustParts: EsQuery[] = [specLevelCreditsCreatorInner(opts)];
  if (opts.role) {
    mustParts.push(termField('levelCredits.role', opts.role, true));
  } else {
    mustParts.push(specContributingCreditRoles());
  }
  return nestedQuery('levelCredits', boolMust(mustParts));
}

/**
 * `field === 'any'`: double-nested credits/creator, restricted to charter/vfxer.
 * Inner creator bool is `should` only (legacy shape).
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
    boolMust([
      nestedQuery('levelCredits.creator', boolShouldOnly(innerShould)),
      specContributingCreditRoles(),
    ]),
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

/**
 * Level aliases (`LevelAlias`) are stored in the top-level nested `aliases` array with a `field`
 * discriminator (e.g. 'song' | 'artist') and an `alias` value.
 */
export function specLevelAliasesByField(opts: {
  field: 'song' | 'artist';
  wildcardValue: string;
}): EsQuery {
  return nestedQuery(
    'aliases',
    boolMust([
      termField('aliases.field', opts.field, true),
      wildcardCi('aliases.alias', opts.wildcardValue),
    ]),
  );
}
