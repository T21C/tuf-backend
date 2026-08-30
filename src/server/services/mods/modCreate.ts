import {getSequelizeForModelGroup} from '@/config/db.js';
import Mod from '@/models/misc/Mod.js';
import ModVersion from '@/models/misc/ModVersion.js';
import type {ModCreateFields} from './modFields.js';
import {allocateAvailableModSlug, rememberSlugRedirect, syncModLatestFromVersions} from './modCatalog.js';
import {normalizeVersionLabel} from './modSlug.js';

const sequelize = getSequelizeForModelGroup('admin');

export async function createCatalogMod(fields: ModCreateFields): Promise<Mod> {
  const count = await Mod.count();
  const transaction = await sequelize.transaction();
  try {
    const slug = await allocateAvailableModSlug(
      {
        projectUrl: fields.projectUrl,
        downloadUrl: fields.downloadUrl,
        name: fields.name,
        fallbackIndex: count + 1,
      },
      {suggested: fields.slug, transaction},
    );
    const version = normalizeVersionLabel(fields.version);
    const created = await Mod.create(
      {
        name: fields.name,
        creatorUsername: fields.creatorUsername,
        creatorDiscordId: fields.creatorDiscordId,
        version,
        description: fields.description,
        downloadUrl: fields.downloadUrl,
        imageUrl: fields.imageUrl,
        projectUrl: fields.projectUrl,
        deprecatedAfter: fields.deprecatedAfter,
        sourceUploadedAt: fields.sourceUploadedAt,
        hidden: fields.hidden,
        isPinned: fields.isPinned,
        slug,
        likes: 0,
        downloadCount: 0,
      },
      {transaction},
    );
    await ModVersion.create(
      {
        modId: created.id,
        version,
        downloadUrl: fields.downloadUrl,
        notes: null,
        releasedAt: fields.sourceUploadedAt,
      },
      {transaction},
    );
    await transaction.commit();
    return created;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function applyModSlugChange(
  mod: Mod,
  nextSlug: string,
): Promise<void> {
  if (mod.slug === nextSlug) return;
  const transaction = await sequelize.transaction();
  try {
    const previous = mod.slug;
    await rememberSlugRedirect({slug: previous, modId: mod.id, transaction});
    await mod.update({slug: nextSlug}, {transaction});
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function createModVersion(options: {
  modId: number;
  version: string;
  downloadUrl: string;
  notes: string | null;
  releasedAt: Date;
}): Promise<ModVersion> {
  const transaction = await sequelize.transaction();
  try {
    const created = await ModVersion.create(
      {
        modId: options.modId,
        version: normalizeVersionLabel(options.version),
        downloadUrl: options.downloadUrl,
        notes: options.notes,
        releasedAt: options.releasedAt,
      },
      {transaction},
    );
    await syncModLatestFromVersions(options.modId, transaction);
    await transaction.commit();
    return created;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function updateModVersion(
  versionRow: ModVersion,
  patch: Partial<{version: string; downloadUrl: string; notes: string | null; releasedAt: Date}>,
): Promise<ModVersion> {
  const transaction = await sequelize.transaction();
  try {
    await versionRow.update(patch, {transaction});
    await syncModLatestFromVersions(versionRow.modId, transaction);
    await transaction.commit();
    await versionRow.reload();
    return versionRow;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function deleteModVersion(versionRow: ModVersion): Promise<void> {
  const remaining = await ModVersion.count({where: {modId: versionRow.modId}});
  if (remaining <= 1) {
    const error = new Error('Cannot delete the only release');
    (error as Error & {status: number}).status = 400;
    throw error;
  }
  const transaction = await sequelize.transaction();
  try {
    const modId = versionRow.modId;
    await versionRow.destroy({transaction});
    await syncModLatestFromVersions(modId, transaction);
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function syncLatestVersionFromPatch(
  mod: Mod,
  patch: {version?: string | null; downloadUrl?: string; sourceUploadedAt?: Date},
): Promise<void> {
  const latest = await ModVersion.findOne({
    where: {modId: mod.id},
    order: [
      ['releasedAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  if (!latest) {
    await createModVersion({
      modId: mod.id,
      version: patch.version ?? mod.version ?? 'unspecified',
      downloadUrl: patch.downloadUrl ?? mod.downloadUrl,
      notes: null,
      releasedAt: patch.sourceUploadedAt ?? mod.sourceUploadedAt,
    });
    return;
  }
  const next: Partial<{version: string; downloadUrl: string; releasedAt: Date}> = {};
  if (patch.version !== undefined) next.version = normalizeVersionLabel(patch.version);
  if (patch.downloadUrl !== undefined) next.downloadUrl = patch.downloadUrl;
  if (patch.sourceUploadedAt !== undefined) next.releasedAt = patch.sourceUploadedAt;
  if (Object.keys(next).length === 0) return;
  await updateModVersion(latest, next);
}
