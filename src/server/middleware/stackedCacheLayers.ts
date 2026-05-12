import { redis } from '@/server/services/core/RedisService.js';
import { logger } from '@/server/services/core/LoggerService.js';

/**
 * Stacked cache layers — independent Redis blobs assembled inside a route handler.
 *
 * **Why this exists:** {@link Cache} wraps the whole HTTP response. When a document is built
 * from multiple sources (e.g. pack **structure** from SQL vs **level payloads** from
 * Elasticsearch), you need hits to flow *into* the handler so you can merge and return one
 * wire shape — not short-circuit before your code runs.
 *
 * **Typical pack GET flow (after refactor):**
 * 1. Remove monolithic `Cache()` from `GET /packs/:id` (or use `skipIf` to bypass while migrating).
 * 2. `readCacheLayer` for `pack:<id>:structure` — on miss, query only `LevelPackItem` rows + folders.
 * 3. `readCacheLayer` for `pack:<id>:levels` — on miss, `fetchPackLevelsFromElasticsearch(levelIds)`.
 * 4. Merge: attach `referencedLevel` per item exactly as today’s handler does.
 * 5. `writeCacheLayer` for each segment that missed (narrow invalidation tags per layer).
 *
 * **Per-user fields:** if the merged body includes user-specific bits (e.g. pass “cleared” flags),
 * either bake `userId` into `packLayerStorageKey` for affected layers, keep those bits uncached,
 * or use a tiny separate layer keyed by user.
 * **Invalidation:** register different `tags` per layer (e.g. `pack:123:layer:structure` vs
 * `pack:123:layer:levels`). Reorder clears structure only; level CDC fans out to `layer:levels`
 * for each affected pack id.
 *
 * Tag keys match {@link Cache}: `cache:tags:<tag>` → SET of storage keys to DELETE on invalidate.
 */

const TAG_KEY_PREFIX = 'cache:tags:';

function cacheTagKey(tag: string): string {
  return `${TAG_KEY_PREFIX}${tag}`;
}

async function attachStorageKeyToTags(storageKey: string, tags: string[]): Promise<void> {
  if (tags.length === 0) return;
  await Promise.all(
    tags.map((tag) =>
      redis.sAdd(cacheTagKey(tag), storageKey).catch((err) => {
        logger.error(`stackedCacheLayers: tag attach failed for ${tag}`, err);
      }),
    ),
  );
}

/** Stable Redis key for one logical layer (not the hashed HTTP cache key). */
export function packLayerStorageKey(
  packId: number,
  layer: 'structure' | 'levels',
  opts?: { fingerprint?: string; userId?: string | null },
): string {
  const fp = opts?.fingerprint ? `:${opts.fingerprint}` : '';
  const user = opts?.userId ? `:u:${opts.userId}` : '';
  return `cache:layer:pack:${packId}:${layer}${fp}${user}`;
}

/** Suggested invalidation tags; callers may add `packs:all`, linkCode aliases, etc. */
export function defaultPackLayerTags(
  packId: number,
  layer: 'structure' | 'levels',
  linkCode?: string | null,
): string[] {
  const tags = [`pack:${packId}:layer:${layer}`, `pack:${packId}`];
  if (linkCode) {
    tags.push(`pack:${linkCode}:layer:${layer}`, `pack:${linkCode}`);
  }
  return tags;
}

export interface ReadCacheLayerResult<T> {
  hit: boolean;
  value: T | null;
}

/**
 * Read one layer only (no fetch). Use this to “pipe” cached slices into assembly logic.
 */
export async function readCacheLayer<T>(storageKey: string): Promise<ReadCacheLayerResult<T>> {
  const value = await redis.get<T>(storageKey);
  return { hit: value != null, value };
}

/**
 * Persist one layer and register the same tag scheme as {@link Cache} so
 * {@link CacheInvalidation.invalidateTag} works unchanged.
 */
export async function writeCacheLayer<T>(
  storageKey: string,
  value: T,
  ttlSec: number,
  tags: string[],
): Promise<boolean> {
  const ok = await redis.set(storageKey, value, ttlSec);
  if (ok) {
    await attachStorageKeyToTags(storageKey, tags);
  }
  return ok;
}

export interface GetOrFetchCacheLayerParams<T> {
  storageKey: string;
  ttlSec: number;
  tags: string[];
  fetch: () => Promise<T>;
}

/**
 * Read-through helper: returns cached value or runs `fetch`, stores, tags.
 */
export async function getOrFetchCacheLayer<T>({
  storageKey,
  ttlSec,
  tags,
  fetch,
}: GetOrFetchCacheLayerParams<T>): Promise<{ value: T; hit: boolean }> {
  const cached = await redis.get<T>(storageKey);
  if (cached != null) {
    return { value: cached, hit: true };
  }
  const value = await fetch();
  await writeCacheLayer(storageKey, value, ttlSec, tags);
  return { value, hit: false };
}

/**
 * Read several layers in parallel (peek only). Handler decides which misses to fill.
 */
export async function readCacheLayers(
  keys: Record<string, string>,
): Promise<Record<string, ReadCacheLayerResult<unknown>>> {
  const entries = await Promise.all(
    Object.entries(keys).map(async ([name, storageKey]) => {
      const r = await readCacheLayer(storageKey);
      return [name, r] as const;
    }),
  );
  return Object.fromEntries(entries);
}
