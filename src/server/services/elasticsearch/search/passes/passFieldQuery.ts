import { convertFromPUA, parseNumericSearchConstraint, prepareSearchTerm } from '@/misc/utils/data/searchHelpers.js';
import { queryParserConfigs, type FieldSearch } from '@/misc/utils/data/queryParser.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { BoolQueryBuilder } from '@/server/services/elasticsearch/search/tools/esQueryBuilder/esQueryBuilder.js';
import {
  matchNone,
  maybeNot,
  nestedQuery,
  rangeOnField,
  termField,
  wildcardCi,
} from '@/server/services/elasticsearch/search/tools/esQueryBuilder/esQueryPrimitives.js';
import type { ParsedNumericSearchConstraint } from '@/misc/utils/data/searchHelpers.js';

const PASS_NUMERIC_RANGE_FIELDS: Record<
  string,
  { esField: string; integerOnly: boolean; scale?: number }
> = {
  id: { esField: 'id', integerOnly: true },
  keycount: { esField: 'keyCount', integerOnly: true },
  score: { esField: 'scoreV2', integerOnly: false },
  xacc: { esField: 'accuracy', integerOnly: false, scale: 0.01 },
  speed: { esField: 'speed', integerOnly: false },
  eperfect: { esField: 'judgements.ePerfect', integerOnly: true },
  perfect: { esField: 'judgements.perfect', integerOnly: true },
  lperfect: { esField: 'judgements.lPerfect', integerOnly: true },
  early: { esField: 'judgements.earlySingle', integerOnly: true },
  miss: { esField: 'judgements.earlyDouble', integerOnly: true },
  late: { esField: 'judgements.lateSingle', integerOnly: true },
  toolate: { esField: 'judgements.lateDouble', integerOnly: true },
};

function scaleNumericConstraint(
  parsed: ParsedNumericSearchConstraint,
  scale: number,
): ParsedNumericSearchConstraint {
  if (scale === 1) return parsed;
  if (parsed.kind === 'term') {
    return { kind: 'term', n: parsed.n * scale };
  }
  const bounds: Partial<{ gt: number; gte: number; lt: number; lte: number }> = {};
  if (parsed.bounds.gt != null) bounds.gt = parsed.bounds.gt * scale;
  if (parsed.bounds.gte != null) bounds.gte = parsed.bounds.gte * scale;
  if (parsed.bounds.lt != null) bounds.lt = parsed.bounds.lt * scale;
  if (parsed.bounds.lte != null) bounds.lte = parsed.bounds.lte * scale;
  return { kind: 'range', bounds };
}

export function buildPassFieldSearchQuery(fieldSearch: FieldSearch): any {
  const { field, value, exact, isNot } = fieldSearch;
  const searchValue = prepareSearchTerm(value);
  //logger.debug(`Building pass search query - Field: ${field}, PUA value: ${value}, Prepared value: ${searchValue}`);

  const numericRangeConfig = PASS_NUMERIC_RANGE_FIELDS[field];
  if (numericRangeConfig) {
    const decoded = convertFromPUA(value).trim();
    const parsed = parseNumericSearchConstraint(decoded, { integerOnly: numericRangeConfig.integerOnly });
    if (!parsed) {
      //logger.debug(`No numeric constraint parsed for field: ${field}, decoded value: ${decoded}`);
      return matchNone();
    }
    const { esField, scale = 1 } = numericRangeConfig;
    const scaled = scaleNumericConstraint(parsed, scale);
    if (scaled.kind === 'term') {
      return maybeNot(isNot, termField(esField, scaled.n));
    }
    return maybeNot(isNot, rangeOnField(esField, scaled.bounds));
  }

  const numericFields = queryParserConfigs.pass.numericFields || [];
  const isNumericField = numericFields.includes(field);

  if (isNumericField && field !== 'any') {
    const numericValue = parseInt(searchValue, 10);

    if (!isNaN(numericValue)) {
      return maybeNot(isNot, termField(field, numericValue));
    } else {
      logger.warn(`Invalid numeric value for field ${field}: ${searchValue}`);
      return matchNone();
    }
  }

  if (field !== 'any') {
    const wildcardValue = exact ? searchValue : `*${searchValue}*`;

    if (field === 'player') {
      const query = new BoolQueryBuilder()
        .should(wildcardCi('player.name', wildcardValue))
        .should(wildcardCi('player.username', wildcardValue))
        .build();
      return maybeNot(isNot, query);
    }

    if (field === 'video') {
      return maybeNot(isNot, wildcardCi('videoLink.keyword', wildcardValue));
    }

    if (field === 'vidtitle') {
      return maybeNot(isNot, wildcardCi('vidTitle', wildcardValue));
    }

    if (field === 'level.song') {
      return maybeNot(isNot, wildcardCi('level.song', wildcardValue));
    }

    if (field === 'level.artist') {
      return maybeNot(isNot, wildcardCi('level.artist', wildcardValue));
    }

    if (field === 'level.dlLink') {
      return maybeNot(isNot, wildcardCi('level.dlLink.keyword', wildcardValue));
    }

    return maybeNot(isNot, wildcardCi(field, wildcardValue));
  }

  const wildcardValue = `*${searchValue}*`;
  const query = new BoolQueryBuilder()
    .should(wildcardCi('player.name', wildcardValue))
    .should(wildcardCi('player.username', wildcardValue))
    .should(wildcardCi('level.song', wildcardValue))
    .should(wildcardCi('level.artist', wildcardValue))
    .should(wildcardCi('videoLink.keyword', wildcardValue))
    .should(wildcardCi('vidTitle', wildcardValue))
    .should(wildcardCi('level.dlLink.keyword', wildcardValue))
    .should(nestedQuery('level.aliases', wildcardCi('level.aliases.alias', wildcardValue)))
    .build();
  return maybeNot(isNot, query);
}
