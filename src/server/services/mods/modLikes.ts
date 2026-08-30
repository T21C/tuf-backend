import {getSequelizeForModelGroup} from '@/config/db.js';
import Mod from '@/models/misc/Mod.js';
import ModLike from '@/models/misc/ModLike.js';
import {indexCatalogMod} from './modSearchIndex.js';
import {invalidatePublicModsCache} from './modCache.js';

const sequelize = getSequelizeForModelGroup('admin');

export async function setModLiked(options: {
  modId: number;
  userId: string;
  action: 'like' | 'unlike';
}): Promise<{ok: true; likes: number} | {ok: false; status: number; error: string}> {
  const transaction = await sequelize.transaction();
  try {
    const mod = await Mod.findByPk(options.modId, {transaction});
    if (!mod || mod.hidden) {
      await transaction.rollback();
      return {ok: false, status: 404, error: 'Mod not found'};
    }

    if (options.action === 'like') {
      const [, created] = await ModLike.findOrCreate({
        where: {modId: options.modId, userId: options.userId},
        defaults: {modId: options.modId, userId: options.userId},
        transaction,
      });
      if (!created) {
        await transaction.rollback();
        return {ok: false, status: 400, error: 'You have already liked this mod'};
      }
    } else {
      const deleted = await ModLike.destroy({
        where: {modId: options.modId, userId: options.userId},
        transaction,
      });
      if (!deleted) {
        await transaction.rollback();
        return {ok: false, status: 400, error: 'You have not liked this mod'};
      }
    }

    const likes = await ModLike.count({where: {modId: options.modId}, transaction});
    await mod.update({likes}, {transaction});
    await transaction.commit();
    await indexCatalogMod(options.modId);
    await invalidatePublicModsCache();
    return {ok: true, likes};
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
