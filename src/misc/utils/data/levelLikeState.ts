import { Op } from 'sequelize';
import LevelLikes from '@/models/levels/LevelLikes.js';

/**
 * Annotate level-like objects with `isLiked` for the given user via one batch
 * query against `level_likes`. When there is no userId or the list is empty,
 * levels are returned unchanged (no `isLiked` field).
 */
export async function annotateLevelsWithLikeState<T extends { id?: number | null }>(
  levels: T[],
  userId: string | null | undefined,
): Promise<(T & { isLiked?: boolean })[]> {
  if (!userId || levels.length === 0) {
    return levels;
  }

  const ids = levels
    .map((level) => level.id)
    .filter((id): id is number => id != null && Number.isFinite(id));

  if (ids.length === 0) {
    return levels;
  }

  const likedRows = await LevelLikes.findAll({
    where: { userId, levelId: { [Op.in]: ids } },
    attributes: ['levelId'],
  });
  const likedSet = new Set(likedRows.map((row) => row.levelId));

  return levels.map((level) => ({
    ...level,
    isLiked: level.id != null ? likedSet.has(level.id) : false,
  }));
}

/**
 * Annotate pack (or similar) items that carry a nested `referencedLevel`.
 * Items without a referenced level are left as-is.
 */
export async function annotateReferencedLevelsWithLikeState<
  T extends { referencedLevel?: { id?: number | null } | null },
>(items: T[], userId: string | null | undefined): Promise<T[]> {
  if (!userId || items.length === 0) {
    return items;
  }

  const levels = items
    .map((item) => item.referencedLevel)
    .filter((level): level is NonNullable<T['referencedLevel']> & { id: number } =>
      level != null && level.id != null,
    );

  if (levels.length === 0) {
    return items;
  }

  const annotated = await annotateLevelsWithLikeState(levels, userId);
  const byId = new Map(annotated.map((level) => [level.id, level]));

  return items.map((item) => {
    const ref = item.referencedLevel;
    if (!ref?.id) return item;
    const next = byId.get(ref.id);
    if (!next) return item;
    return { ...item, referencedLevel: next };
  });
}
