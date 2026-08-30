import client, {modIndexName} from '@/config/elasticsearch.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {serializedModFromIndexSource} from '@/server/services/elasticsearch/indexing/modIndexDocument.js';
import type {SerializedMod} from '@/server/services/mods/serializeMod.js';
import {
  buildModSearchQuery,
  buildModSearchSort,
  parseModLimit,
  parseModOffset,
  type ModSearchOptions,
} from './modSearchQuery.js';

export type {ModSearchOptions};
export {
  buildModSearchQuery,
  buildModSearchSort,
  buildModTextShould,
  parseModLimit,
  parseModOffset,
  parseModSearchQ,
  parseModSort,
} from './modSearchQuery.js';

export type ModSearchResult = {
  total: number;
  mods: SerializedMod[];
  offset: number;
  limit: number;
  hasMore: boolean;
};

export async function searchMods(options: ModSearchOptions = {}): Promise<ModSearchResult> {
  const offset = parseModOffset(options.offset);
  const limit = parseModLimit(options.limit);
  const query = buildModSearchQuery({
    q: options.q?.trim() || undefined,
    includeHidden: options.includeHidden,
    facetQueryV1: options.facetQueryV1,
  });
  const sort = buildModSearchSort(options.sort);

  try {
    const response = await client.search({
      index: modIndexName,
      from: offset,
      size: limit,
      query,
      sort,
      track_total_hits: true,
    });
    const hits = Array.isArray(response.hits?.hits) ? response.hits.hits : [];
    const totalRaw = response.hits?.total;
    const total =
      typeof totalRaw === 'number' ? totalRaw : typeof totalRaw?.value === 'number' ? totalRaw.value : hits.length;
    const mods = hits.map((hit) =>
      serializedModFromIndexSource((hit._source || {}) as Record<string, unknown>, {
        includeHidden: options.includeHidden,
      }),
    );
    return {total, mods, offset, limit, hasMore: offset + mods.length < total};
  } catch (error) {
    logger.error('Mod search failed:', error);
    throw error;
  }
}
