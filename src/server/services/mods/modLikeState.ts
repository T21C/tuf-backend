import {Op} from 'sequelize';
import ModLike from '@/models/misc/ModLike.js';

export async function annotateModsWithLikeState<T extends {id?: number | null}>(
  mods: T[],
  userId: string | null | undefined,
): Promise<(T & {isLiked?: boolean})[]> {
  if (!userId || mods.length === 0) return mods;

  const ids = mods
    .map((mod) => mod.id)
    .filter((id): id is number => id != null && Number.isFinite(id));
  if (ids.length === 0) return mods;

  const likedRows = await ModLike.findAll({
    where: {userId, modId: {[Op.in]: ids}},
    attributes: ['modId'],
  });
  const likedSet = new Set(likedRows.map((row) => row.modId));
  return mods.map((mod) => ({
    ...mod,
    isLiked: mod.id != null ? likedSet.has(mod.id) : false,
  }));
}
