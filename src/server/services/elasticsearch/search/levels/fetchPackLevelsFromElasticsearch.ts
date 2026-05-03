import client, { levelIndexName } from '@/config/elasticsearch.js';
import { logger } from '@/server/services/core/LoggerService.js';
import Difficulty from '@/models/levels/Difficulty.js';
import CurationType from '@/models/curations/CurationType.js';
import { Op } from 'sequelize';
import {
  enrichLevelCurationAliases,
  serializeCurationJsonFromEsShape,
  sortCurationsByTypeOrder,
} from '@/misc/utils/data/curationOrdering.js';
import { convertLevelSearchHit } from './levelSearch.js';

const MGET_CHUNK = 500;

/**
 * Load many levels for pack tree/detail from Elasticsearch (denormalized doc) instead of
 * wide MySQL joins. Hydrates curation `types` from {@link CurationType} using `typeIds` stored in the index.
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

  const diffIds = [
    ...new Set(
      [...sourcesById.values()]
        .map((s) => s.diffId)
        .filter((d): d is number => typeof d === 'number' && Number.isFinite(d))
    ),
  ];
  const diffs =
    diffIds.length === 0
      ? []
      : await Difficulty.findAll({
          where: { id: { [Op.in]: diffIds } },
        });

  const allTypeIds = new Set<number>();
  for (const src of sourcesById.values()) {
    const curations = src.curations;
    if (!Array.isArray(curations)) {
      continue;
    }
    for (const c of curations as Record<string, unknown>[]) {
      const tids = c.typeIds;
      if (!Array.isArray(tids)) {
        continue;
      }
      for (const tid of tids) {
        if (typeof tid === 'number' && Number.isFinite(tid)) {
          allTypeIds.add(tid);
        }
      }
    }
  }

  const typesById = new Map<number, InstanceType<typeof CurationType>>();
  if (allTypeIds.size > 0) {
    const rows = await CurationType.findAll({
      where: { id: { [Op.in]: [...allTypeIds] } },
    });
    for (const row of rows) {
      typesById.set(row.id, row);
    }
  }

  for (const [id, source] of sourcesById) {
    let hit = convertLevelSearchHit(source, diffs) as Record<string, unknown>;
    const curationsRaw = hit.curations;
    if (Array.isArray(curationsRaw) && curationsRaw.length > 0) {
      const hydratedForSort = (curationsRaw as Record<string, unknown>[]).map((c) => {
        const tids = (c.typeIds as number[] | undefined) || [];
        const types = tids
          .map((tid) => typesById.get(tid))
          .filter((t): t is InstanceType<typeof CurationType> => t != null);
        return { ...c, types };
      });
      const sortedHydrated = sortCurationsByTypeOrder(hydratedForSort as Parameters<typeof sortCurationsByTypeOrder>[0]);
      const serializedCurations = sortedHydrated.map((row) => {
        const r = row as Record<string, unknown> & { types: InstanceType<typeof CurationType>[] };
        const { types, ...rest } = r;
        return serializeCurationJsonFromEsShape(rest, types);
      });
      hit = { ...hit, curations: serializedCurations };
      enrichLevelCurationAliases(hit);
    } else {
      hit = { ...hit, curations: [] };
      enrichLevelCurationAliases(hit);
    }
    out.set(id, hit);
  }

  if (out.size < unique.length) {
    logger.debug('fetchPackLevelsFromElasticsearch: some level ids missing or filtered in ES', {
      requested: unique.length,
      returned: out.size,
    });
  }

  return out;
}
