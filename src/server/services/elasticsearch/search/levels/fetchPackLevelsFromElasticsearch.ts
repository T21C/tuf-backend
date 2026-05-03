import client, { levelIndexName } from '@/config/elasticsearch.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { buildPackReferencedLevelFromEsSource } from './packReferencedLevelSerialize.js';

const MGET_CHUNK = 500;

/**
 * Load many levels for pack tree/detail from Elasticsearch (denormalized doc) instead of
 * wide MySQL joins. Returns a minimal per-level payload for pack UI (see {@link buildPackReferencedLevelFromEsSource}).
 */
export async function fetchPackLevelsFromElasticsearch(
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
    out.set(id, buildPackReferencedLevelFromEsSource(source));
  }

  if (out.size < unique.length) {
    logger.debug('fetchPackLevelsFromElasticsearch: some level ids missing or filtered in ES', {
      requested: unique.length,
      returned: out.size,
    });
  }

  return out;
}
