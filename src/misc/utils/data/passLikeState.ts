import { Op } from 'sequelize';
import PassLikes from '@/models/passes/PassLikes.js';

/**
 * Annotate pass-like objects with `isLiked` for the given user via one batch
 * query against `pass_likes`. When there is no userId or the list is empty,
 * passes are returned unchanged (no `isLiked` field).
 */
export async function annotatePassesWithLikeState<T extends { id?: number | null }>(
  passes: T[],
  userId: string | null | undefined,
): Promise<(T & { isLiked?: boolean })[]> {
  if (!userId || passes.length === 0) {
    return passes;
  }

  const ids = passes
    .map((pass) => pass.id)
    .filter((id): id is number => id != null && Number.isFinite(id));

  if (ids.length === 0) {
    return passes;
  }

  const likedRows = await PassLikes.findAll({
    where: { userId, passId: { [Op.in]: ids } },
    attributes: ['passId'],
  });
  const likedSet = new Set(likedRows.map((row) => row.passId));

  return passes.map((pass) => ({
    ...pass,
    isLiked: pass.id != null ? likedSet.has(pass.id) : false,
  }));
}
