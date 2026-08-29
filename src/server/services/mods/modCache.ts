import {CacheInvalidation} from '@/server/middleware/cache.js';

export const PUBLIC_MODS_CACHE_TAG = 'mods:public';

export async function invalidatePublicModsCache(): Promise<void> {
  await CacheInvalidation.invalidateTags([PUBLIC_MODS_CACHE_TAG]).catch(() => undefined);
}
