import {Op, type Transaction} from 'sequelize';
import Mod from '@/models/misc/Mod.js';
import ModSlugRedirect from '@/models/misc/ModSlugRedirect.js';
import ModVersion from '@/models/misc/ModVersion.js';
import {
  allocateModSlug,
  isReservedModSlug,
  normalizeModSlug,
  uniqueWithNumericSuffix,
  type SlugSource,
} from './modSlug.js';

export async function loadTakenSlugs(options?: {
  excludeModId?: number;
  transaction?: Transaction;
}): Promise<Set<string>> {
  const taken = new Set<string>();
  const mods = await Mod.findAll({
    attributes: ['id', 'slug'],
    transaction: options?.transaction,
  });
  for (const mod of mods) {
    if (options?.excludeModId != null && mod.id === options.excludeModId) continue;
    if (mod.slug) taken.add(mod.slug);
  }
  const redirects = await ModSlugRedirect.findAll({
    attributes: ['slug', 'modId'],
    transaction: options?.transaction,
  });
  for (const row of redirects) {
    if (options?.excludeModId != null && row.modId === options.excludeModId) continue;
    taken.add(row.slug);
  }
  return taken;
}

export async function allocateAvailableModSlug(
  source: SlugSource,
  options?: {excludeModId?: number; suggested?: string | null; transaction?: Transaction},
): Promise<string> {
  const taken = await loadTakenSlugs({
    excludeModId: options?.excludeModId,
    transaction: options?.transaction,
  });
  if (options?.suggested) {
    const normalized = normalizeModSlug(options.suggested);
    if (normalized && !isReservedModSlug(normalized)) {
      return uniqueWithNumericSuffix(normalized, taken);
    }
  }
  return allocateModSlug(source, taken);
}

export async function latestModVersion(
  modId: number,
  transaction?: Transaction,
): Promise<ModVersion | null> {
  return ModVersion.findOne({
    where: {modId},
    order: [
      ['releasedAt', 'DESC'],
      ['id', 'DESC'],
    ],
    transaction,
  });
}

export async function syncModLatestFromVersions(
  modId: number,
  transaction?: Transaction,
): Promise<Mod | null> {
  const mod = await Mod.findByPk(modId, {transaction});
  if (!mod) return null;
  const latest = await latestModVersion(modId, transaction);
  if (!latest) return mod;
  await mod.update(
    {
      version: latest.version,
      downloadUrl: latest.downloadUrl,
      sourceUploadedAt: latest.releasedAt,
    },
    {transaction},
  );
  return mod;
}

export async function findModVersion(
  modId: number,
  version: string,
  transaction?: Transaction,
): Promise<ModVersion | null> {
  return ModVersion.findOne({where: {modId, version}, transaction});
}

export async function listModVersions(modId: number, transaction?: Transaction): Promise<ModVersion[]> {
  return ModVersion.findAll({
    where: {modId},
    order: [
      ['releasedAt', 'DESC'],
      ['id', 'DESC'],
    ],
    transaction,
  });
}

export async function findModBySlug(
  slug: string,
  transaction?: Transaction,
): Promise<{mod: Mod; redirectedFrom: string | null} | null> {
  const trimmed = String(slug || '').trim();
  if (!trimmed) return null;
  const direct = await Mod.findOne({where: {slug: trimmed}, transaction});
  if (direct) return {mod: direct, redirectedFrom: null};
  const redirect = await ModSlugRedirect.findOne({where: {slug: trimmed}, transaction});
  if (!redirect) return null;
  const mod = await Mod.findByPk(redirect.modId, {transaction});
  if (!mod) return null;
  return {mod, redirectedFrom: trimmed};
}

export async function rememberSlugRedirect(options: {
  slug: string;
  modId: number;
  transaction?: Transaction;
}): Promise<void> {
  const slug = String(options.slug || '').trim();
  if (!slug) return;
  await ModSlugRedirect.destroy({
    where: {slug, modId: {[Op.ne]: options.modId}},
    transaction: options.transaction,
  });
  await ModSlugRedirect.findOrCreate({
    where: {slug},
    defaults: {slug, modId: options.modId},
    transaction: options.transaction,
  });
}
