import { convertToPUA } from '@/misc/utils/data/searchHelpers.js';
import type { EsQuery } from '@/server/services/elasticsearch/search/tools/esQueryBuilder/esQueryPrimitives.js';
import {
  boolMust,
  boolMustNot,
  boolShould,
  termField,
  wildcardCi,
} from '@/server/services/elasticsearch/search/tools/esQueryBuilder/esQueryPrimitives.js';

/**
 * ES equivalent of {@link hasDomesticCdnFile}: non-empty dlLink, not `removed`,
 * and starts with a recognized TUF CDN base URL. `dlLink` is PUA-encoded in the index.
 */
function specDomesticCdnDlLink(cdnBaseUrls: string[]): EsQuery {
  const prefixes = [
    ...new Set(cdnBaseUrls.map((url) => String(url || '').replace(/\/+$/, '')).filter(Boolean)),
  ];
  const prefixQueries = prefixes.map((cdnBaseUrl) =>
    wildcardCi('dlLink.keyword', `${convertToPUA(cdnBaseUrl)}*`),
  );
  if (prefixQueries.length === 0) {
    return boolMust([
      boolMustNot([
        termField('dlLink.keyword', ''),
        termField('dlLink.keyword', 'removed'),
      ]),
      termField('dlLink.keyword', '__no_cdn_prefix_configured__'),
    ]);
  }
  const prefixClause =
    prefixQueries.length === 1 ? prefixQueries[0] : boolShould(1, prefixQueries);
  return boolMust([
    boolMustNot([
      termField('dlLink.keyword', ''),
      termField('dlLink.keyword', 'removed'),
    ]),
    prefixClause,
  ]);
}

export function buildAvailableDlOnlyClause(cdnBaseUrls: string[]): EsQuery {
  return specDomesticCdnDlLink(cdnBaseUrls);
}

export function buildAvailableDlHideClause(cdnBaseUrls: string[]): EsQuery {
  return boolMustNot([specDomesticCdnDlLink(cdnBaseUrls)]);
}
