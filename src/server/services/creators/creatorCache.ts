import {Op} from 'sequelize';
import User from '@/models/auth/User.js';
import {CacheInvalidation} from '@/server/middleware/cache.js';

export const CREATORS_ALL_CACHE_TAG = 'creators:all';

export const CREATOR_REFERENCE_CACHE_TAGS = ['references:all', 'references:level'] as const;

export function creatorCacheTag(creatorId: number): string {
  return `creator:${creatorId}`;
}

export function creatorCacheTags(creatorIds: Iterable<number>): string[] {
  const unique = [...new Set(creatorIds)].filter((id) => Number.isFinite(id) && id > 0);
  return [CREATORS_ALL_CACHE_TAG, ...unique.map(creatorCacheTag)];
}

export async function invalidateCreatorsCache(creatorIds: number[]): Promise<void> {
  const unique = [...new Set(creatorIds)].filter((id) => Number.isFinite(id) && id > 0);
  await CacheInvalidation.invalidateTags(creatorCacheTags(unique)).catch(() => undefined);
  if (unique.length === 0) return;

  const users = await User.findAll({
    where: {creatorId: {[Op.in]: unique}},
    attributes: ['id'],
  });
  await Promise.all(
    users.map((row) => CacheInvalidation.invalidateUser(row.id).catch(() => undefined)),
  );
}

export async function invalidateCreatorReferenceCaches(): Promise<void> {
  await CacheInvalidation.invalidateTags([...CREATOR_REFERENCE_CACHE_TAGS]).catch(() => undefined);
}
