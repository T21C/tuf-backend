import { Op } from 'sequelize';
import { LevelPack, LevelPackItem } from '@/models/packs/index.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import {
  defaultPackLayerTags,
  getOrFetchCacheLayer,
  packLayerStorageKey,
  writeCacheLayer,
} from '@/server/middleware/stackedCacheLayers.js';
import { fetchPackLevelsFromElasticsearch } from '@/server/services/elasticsearch/search/levels/fetchPackLevelsFromElasticsearch.js';

/** Flat skeleton rows (no referencedLevel) — cached as the “structure” layer. */
export type PackStructureFlatRow = {
  id: number;
  type: string;
  parentId: number;
  sortOrder: number;
  name: string | null;
  levelId: number | null;
};

export type PackStructureLayerPayload = {
  flatItems: PackStructureFlatRow[];
};

/** ES-backed level blobs keyed by level id (string keys in JSON). */
export type PackLevelsLayerPayload = Record<string, Record<string, unknown>>;

export const PACK_GET_LAYER_TTL_SEC =
  process.env.NODE_ENV === 'production' ? 60 * 60 * 24 : 5;

function layerTagsStructure(packId: number, linkCode: string | null | undefined): string[] {
  return defaultPackLayerTags(packId, 'structure', linkCode);
}

function layerTagsLevels(packId: number, linkCode: string | null | undefined): string[] {
  return defaultPackLayerTags(packId, 'levels', linkCode);
}

export function flatRowsToTreeItems(
  flat: PackStructureFlatRow[],
  levelsById: Map<number, Record<string, unknown>>,
  clearedLevelIds: number[],
): any[] {
  const levels = flat
    .filter((row) => row.type === 'level' && row.levelId != null)
    .map((row) => {
      const levelData = levelsById.get(row.levelId!);
      if (!levelData) return null;
      return {
        id: row.id,
        type: row.type,
        parentId: row.parentId,
        levelId: row.levelId,
        sortOrder: row.sortOrder,
        referencedLevel: levelData,
        isCleared: clearedLevelIds.includes(row.levelId || 0),
      };
    })
    .filter(Boolean);

  const foldersPlain = flat
    .filter((row) => row.type === 'folder')
    .map((row) => ({
      id: row.id,
      type: row.type,
      parentId: row.parentId,
      name: row.name,
      sortOrder: row.sortOrder,
      isCleared: false,
    }));

  return [...foldersPlain, ...levels];
}

export async function loadPackStructureFlatFromDb(packId: number): Promise<PackStructureFlatRow[]> {
  const rows = await LevelPackItem.findAll({
    where: { packId },
    attributes: ['id', 'type', 'parentId', 'sortOrder', 'name', 'levelId'],
    order: [['sortOrder', 'ASC']],
  });
  return rows.map((r) => {
    const j = r.toJSON() as unknown as Record<string, unknown>;
    return {
      id: Number(j.id),
      type: String(j.type),
      parentId: Number(j.parentId ?? 0),
      sortOrder: Number(j.sortOrder ?? 0),
      name: j.name != null ? String(j.name) : null,
      levelId: j.levelId != null ? Number(j.levelId) : null,
    };
  });
}

function mapFromLevelsPayload(payload: PackLevelsLayerPayload): Map<number, Record<string, unknown>> {
  const m = new Map<number, Record<string, unknown>>();
  for (const [k, v] of Object.entries(payload)) {
    const id = Number(k);
    if (Number.isFinite(id) && v && typeof v === 'object') {
      m.set(id, v);
    }
  }
  return m;
}

function levelsMapToPayload(map: Map<number, Record<string, unknown>>): PackLevelsLayerPayload {
  const o: PackLevelsLayerPayload = {};
  for (const [id, doc] of map) {
    o[String(id)] = doc;
  }
  return o;
}

/**
 * Resolve structure + levels layers (stacked cache), return merged flat item list
 * (folders + level rows with referencedLevel + isCleared).
 */
export async function resolvePackItemsWithStackedCache(
  packId: number,
  linkCode: string | null | undefined,
  clearedLevelIds: number[],
): Promise<{ flatItemsMerged: any[]; structureHit: boolean; levelsHit: boolean }> {
  const structureKey = packLayerStorageKey(packId, 'structure');
  const levelsKey = packLayerStorageKey(packId, 'levels');

  const { value: structure, hit: structureHit } = await getOrFetchCacheLayer<PackStructureLayerPayload>({
    storageKey: structureKey,
    ttlSec: PACK_GET_LAYER_TTL_SEC,
    tags: layerTagsStructure(packId, linkCode),
    fetch: async () => ({
      flatItems: await loadPackStructureFlatFromDb(packId),
    }),
  });

  const levelIds = [
    ...new Set(
      structure.flatItems
        .filter((r) => r.type === 'level' && r.levelId != null)
        .map((r) => r.levelId!),
    ),
  ];

  let levelsHit = false;
  const { value: levelsPayload, hit: levelsLayerHit } = await getOrFetchCacheLayer<PackLevelsLayerPayload>({
    storageKey: levelsKey,
    ttlSec: PACK_GET_LAYER_TTL_SEC,
    tags: layerTagsLevels(packId, linkCode),
    fetch: async () => {
      const map =
        levelIds.length > 0
          ? await fetchPackLevelsFromElasticsearch(levelIds)
          : new Map<number, Record<string, unknown>>();
      return levelsMapToPayload(map);
    },
  });
  levelsHit = levelsLayerHit;

  let levelsMap = mapFromLevelsPayload(levelsPayload);
  const missingLevelIds = levelIds.filter((id) => !levelsMap.has(id));
  if (missingLevelIds.length > 0) {
    const fresh = await fetchPackLevelsFromElasticsearch(missingLevelIds);
    for (const [id, doc] of fresh) {
      levelsMap.set(id, doc);
    }
    await writeCacheLayer(
      levelsKey,
      levelsMapToPayload(levelsMap),
      PACK_GET_LAYER_TTL_SEC,
      layerTagsLevels(packId, linkCode),
    );
    levelsHit = false;
  }

  const flatItemsMerged = flatRowsToTreeItems(structure.flatItems, levelsMap, clearedLevelIds);

  return { flatItemsMerged, structureHit, levelsHit };
}

/** Invalidate only the pack tree / item-layout layer (reorder, folder rename, etc.). */
export async function invalidatePackStructureLayers(packId: number): Promise<void> {
  const pack = await LevelPack.findByPk(packId, { attributes: ['linkCode'] });
  const tags = layerTagsStructure(packId, pack?.linkCode ?? null);
  await CacheInvalidation.invalidateTags(tags);
}

/** Invalidate only ES-backed level blobs for one pack. */
export async function invalidatePackLevelsLayers(packId: number): Promise<void> {
  const pack = await LevelPack.findByPk(packId, { attributes: ['linkCode'] });
  const tags = layerTagsLevels(packId, pack?.linkCode ?? null);
  await CacheInvalidation.invalidateTags(tags);
}

/** When level rows change in CDC, drop levels cache for every pack that references those levels. */
export async function invalidatePackLevelsCachesForLevelIds(levelIds: number[]): Promise<void> {
  const unique = [...new Set(levelIds)].filter((id) => id != null && id > 0);
  if (unique.length === 0) return;

  const items = await LevelPackItem.findAll({
    where: { type: 'level', levelId: { [Op.in]: unique } },
    attributes: ['packId'],
  });

  const packIds = [...new Set(items.map((i) => i.packId))];
  await Promise.all(packIds.map((pid) => invalidatePackLevelsLayers(pid)));
}

/** Tags to invalidate alongside legacy monolithic pack HTTP cache (GET pack no longer uses it, but lists may). */
export function packDetailLayerTagsForFullInvalidation(
  packId: number,
  linkCode: string | null | undefined,
): string[] {
  return [...layerTagsStructure(packId, linkCode), ...layerTagsLevels(packId, linkCode)];
}
