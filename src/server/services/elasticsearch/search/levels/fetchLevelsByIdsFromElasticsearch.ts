import client, { levelIndexName } from '@/config/elasticsearch.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { convertLevelSearchHit } from '@/server/services/elasticsearch/search/levels/levelSearch.js';

const MGET_CHUNK = 500;

/**
 * Load levels by id from Elasticsearch via chunked `mget`.
 *
 * Shared hydration path for callers that already have level ids (packs, rating list, etc.).
 * Decoding uses {@link convertLevelSearchHit} — the same PUA decode as public level search.
 * Callers may further prune/adapt the returned objects for their UI shape.
 *
 * Skips docs that are missing, deleted, or hidden.
 */
export async function fetchLevelsByIdsFromElasticsearch(
  levelIds: number[]
): Promise<Map<number, Record<string, unknown>>> {
  const unique = [...new Set(levelIds)].filter((id) => id != null && id > 0);
  const out = new Map<number, Record<string, unknown>>();
  if (unique.length === 0) {
    return out;
  }

  const sourcesById = new Map<number, Record<string, unknown>>();

  for (let i = 0; i < unique.length; i += MGET_CHUNK) {
    const chunk = unique.slice(i, i + MGET_CHUNK);
    const res = await client.mget({
      index: levelIndexName,
      ids: chunk.map((id) => String(id)),
    });
    for (const doc of res.docs) {
      if (!('found' in doc) || !doc.found || !doc._source) {
        continue;
      }
      const src = doc._source as Record<string, unknown>;
      const id = typeof src.id === 'number' ? src.id : parseInt(String(doc._id), 10);
      if (!Number.isFinite(id)) {
        continue;
      }
      if (src.isDeleted === true || src.isHidden === true) {
        continue;
      }
      sourcesById.set(id, src);
    }
  }

  for (const [id, source] of sourcesById) {
    // Difficulty rows are unused by id-hydration callers that prune further; skip DB round-trip.
    out.set(id, convertLevelSearchHit(source, []) as Record<string, unknown>);
  }

  if (out.size < unique.length) {
    logger.debug('fetchLevelsByIdsFromElasticsearch: some level ids missing or filtered in ES', {
      requested: unique.length,
      returned: out.size,
    });
  }

  return out;
}
