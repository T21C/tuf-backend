import {CacheInvalidation} from '@/server/middleware/cache.js';

export const PUBLIC_LINKS_CACHE_TAG = 'resources:links:public';

export async function invalidateAllPublicResourceCaches(): Promise<void> {
  await CacheInvalidation.invalidateTags([PUBLIC_LINKS_CACHE_TAG]).catch(() => undefined);
}
