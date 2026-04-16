import { Op } from 'sequelize';
import Level from '@/models/levels/Level.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import { logger } from '@/server/services/core/LoggerService.js';

/**
 * Atomically increment `levels.downloadCount` for every level whose `fileId`
 * column matches one of the provided CDN file IDs, then invalidate the level
 * detail / list HTTP caches for the affected rows.
 *
 * `Level.increment` does not fire Sequelize bulk-update hooks, so the cache
 * invalidation that normally piggybacks on `afterBulkUpdate` is performed
 * explicitly here.
 *
 * @returns number of level rows whose `downloadCount` was incremented.
 */
export async function incrementLevelDownloadCountsForFileIds(
  fileIds: readonly (string | null | undefined)[],
  by = 1,
): Promise<number> {
  const unique = [
    ...new Set(
      fileIds.filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
    ),
  ];
  if (unique.length === 0 || by === 0) return 0;

  const affectedRows = await Level.findAll({
    where: { fileId: { [Op.in]: unique } },
    attributes: ['id'],
  });
  if (affectedRows.length === 0) return 0;

  await Level.increment('downloadCount', {
    by,
    where: { fileId: { [Op.in]: unique } },
  });

  try {
    const tags = [
      'levels:all',
      ...affectedRows.map((row) => `level:${row.id}`),
    ];
    await CacheInvalidation.invalidateTags(tags);
  } catch (error) {
    logger.warn(
      'Failed to invalidate level cache after downloadCount increment',
      {
        error: error instanceof Error ? error.message : String(error),
        fileIds: unique,
      },
    );
  }

  return affectedRows.length;
}
