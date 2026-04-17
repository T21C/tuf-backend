import type { EsQuery } from '@/server/services/elasticsearch/search/tools/esQueryBuilder/esQueryPrimitives.js';
import {
  boolMust,
  boolMustNot,
  boolShould,
  existsField,
  termField,
} from '@/server/services/elasticsearch/search/tools/esQueryBuilder/esQueryPrimitives.js';

function specNonEmptyKeywordField(field: string): EsQuery {
  return boolMust([
    existsField(field),
    boolMustNot([termField(`${field}.keyword`, '')]),
  ]);
}

export function buildAvailableDlOnlyClause(): EsQuery {
  return boolShould(1, [
    termField('isExternallyAvailable', true),
    specNonEmptyKeywordField('dlLink'),
    specNonEmptyKeywordField('workshopLink'),
  ]);
}

export function buildAvailableDlHideClause(): EsQuery {
  return boolMustNot([
    boolShould(1, [
      termField('isExternallyAvailable', true),
      specNonEmptyKeywordField('dlLink'),
      specNonEmptyKeywordField('workshopLink'),
    ]),
  ]);
}
