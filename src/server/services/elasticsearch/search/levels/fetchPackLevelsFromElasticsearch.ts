import { fetchLevelsByIdsFromElasticsearch } from './fetchLevelsByIdsFromElasticsearch.js';
import { pruneMysqlReferencedLevelForPack } from './packReferencedLevelSerialize.js';

/**
 * Load pack tree/detail levels from Elasticsearch and prune to the minimal pack-UI shape.
 */
export async function fetchPackLevelsFromElasticsearch(
  levelIds: number[]
): Promise<Map<number, Record<string, unknown>>> {
  const levels = await fetchLevelsByIdsFromElasticsearch(levelIds);
  const out = new Map<number, Record<string, unknown>>();

  for (const [id, level] of levels) {
    const pruned = pruneMysqlReferencedLevelForPack(level);
    if (pruned) {
      out.set(id, pruned);
    }
  }

  return out;
}
