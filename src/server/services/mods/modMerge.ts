import type {Transaction} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import Mod from '@/models/misc/Mod.js';
import ModAssignee from '@/models/misc/ModAssignee.js';
import ModLike from '@/models/misc/ModLike.js';
import ModSlugRedirect from '@/models/misc/ModSlugRedirect.js';
import ModTagAssignment from '@/models/misc/ModTagAssignment.js';
import ModVersion from '@/models/misc/ModVersion.js';
import ModDownloadUnique from '@/models/misc/ModDownloadUnique.js';
import {uniqueWithNumericSuffix} from './modSlug.js';
import {rememberSlugRedirect, syncModLatestFromVersions} from './modCatalog.js';
import {deleteCatalogMod, indexCatalogMod} from './modSearchIndex.js';
import {invalidatePublicModsCache} from './modCache.js';
import {serializeMod, type SerializedMod} from './serializeMod.js';
import {deleteStoredModIcon} from './modIcon.js';

const sequelize = getSequelizeForModelGroup('admin');

export type MergeModsResult =
  | {ok: true; mod: SerializedMod}
  | {ok: false; status: number; error: string};

async function moveVersions(sourceId: number, targetId: number, transaction: Transaction): Promise<void> {
  const [sourceVersions, targetVersions] = await Promise.all([
    ModVersion.findAll({where: {modId: sourceId}, transaction}),
    ModVersion.findAll({where: {modId: targetId}, transaction}),
  ]);
  const taken = new Set(targetVersions.map((row) => row.version));
  for (const row of sourceVersions) {
    const nextLabel = uniqueWithNumericSuffix(row.version, taken);
    taken.add(nextLabel);
    await row.update({modId: targetId, version: nextLabel}, {transaction});
  }
}

export async function mergeMods(options: {
  targetId: number;
  sourceId: number;
}): Promise<MergeModsResult> {
  if (options.targetId === options.sourceId) {
    return {ok: false, status: 400, error: 'Cannot merge a mod into itself'};
  }

  const transaction = await sequelize.transaction();
  try {
    const target = await Mod.findByPk(options.targetId, {transaction});
    const source = await Mod.findByPk(options.sourceId, {transaction});
    if (!target || !source) {
      await transaction.rollback();
      return {ok: false, status: 404, error: 'Mod not found'};
    }

    await moveVersions(source.id, target.id, transaction);

    const sourceAssignees = await ModAssignee.findAll({where: {modId: source.id}, transaction});
    const targetAssignees = await ModAssignee.findAll({where: {modId: target.id}, transaction});
    const assignedUsers = new Set(targetAssignees.map((row) => row.userId));
    for (const row of sourceAssignees) {
      if (assignedUsers.has(row.userId)) continue;
      await row.update({modId: target.id}, {transaction});
      assignedUsers.add(row.userId);
    }
    await ModAssignee.destroy({where: {modId: source.id}, transaction});

    const sourceTags = await ModTagAssignment.findAll({where: {modId: source.id}, transaction});
    const targetTags = await ModTagAssignment.findAll({where: {modId: target.id}, transaction});
    const tagIds = new Set(targetTags.map((row) => row.tagId));
    for (const row of sourceTags) {
      if (tagIds.has(row.tagId)) continue;
      await row.update({modId: target.id}, {transaction});
      tagIds.add(row.tagId);
    }
    await ModTagAssignment.destroy({where: {modId: source.id}, transaction});

    const sourceLikes = await ModLike.findAll({where: {modId: source.id}, transaction});
    const targetLikes = await ModLike.findAll({where: {modId: target.id}, transaction});
    const likedUsers = new Set(targetLikes.map((row) => row.userId));
    for (const row of sourceLikes) {
      if (likedUsers.has(row.userId)) continue;
      await row.update({modId: target.id}, {transaction});
      likedUsers.add(row.userId);
    }
    await ModLike.destroy({where: {modId: source.id}, transaction});

    await target.update(
      {
        isPinned: Boolean(target.isPinned || source.isPinned),
        likes: likedUsers.size,
        downloadCount: (target.downloadCount || 0) + (source.downloadCount || 0),
      },
      {transaction},
    );

    await rememberSlugRedirect({slug: source.slug, modId: target.id, transaction});
    await ModSlugRedirect.update({modId: target.id}, {where: {modId: source.id}, transaction});
    await ModDownloadUnique.destroy({where: {modId: source.id}, transaction});

    const sourceImageUrl = source.imageUrl;
    await source.destroy({transaction});
    await syncModLatestFromVersions(target.id, transaction);
    await transaction.commit();

    await deleteStoredModIcon(sourceImageUrl).catch(() => undefined);
    await deleteCatalogMod(source.id);
    await indexCatalogMod(target.id);
    await invalidatePublicModsCache();
    const fresh = await Mod.findByPk(target.id);
    return {ok: true, mod: await serializeMod(fresh || target, {includeHidden: true})};
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
