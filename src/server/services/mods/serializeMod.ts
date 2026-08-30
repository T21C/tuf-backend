import type Mod from '@/models/misc/Mod.js';
import type ModVersion from '@/models/misc/ModVersion.js';
import ModAssignee from '@/models/misc/ModAssignee.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import {loadUserSummariesByIds, type ModUserSummary} from './modUsers.js';
import {loadTagsByModIds, type SerializedModTag} from './modTags.js';
import {getFileIdFromCdnUrl, isCdnUrl} from '@/misc/utils/Utility.js';
import {isGithubComUrl} from './modReleaseImportClassify.js';
import {displayNameFromModZipMetadata} from './modZipValidate.js';
import {listModVersions} from './modCatalog.js';

export type SerializedModVersion = {
  id: number;
  version: string;
  downloadUrl: string;
  notes: string | null;
  releasedAt: Date;
  source: 'hosted' | 'github' | 'external';
  originalFilename?: string | null;
};

export type SerializedMod = {
  id: number;
  slug: string;
  name: string;
  creatorUsername: string;
  creatorDiscordId: string;
  version: string | null;
  description: string | null;
  downloadUrl: string;
  imageUrl: string | null;
  projectUrl: string | null;
  deprecatedAfter: string | null;
  sourceUploadedAt: Date;
  hidden?: boolean;
  isPinned: boolean;
  likes: number;
  downloadCount: number;
  tags: SerializedModTag[];
  assignees: ModUserSummary[];
  postedBy: ModUserSummary | null;
  isLiked?: boolean;
  versions?: SerializedModVersion[];
  latestVersion?: SerializedModVersion | null;
  selectedVersion?: SerializedModVersion | null;
};

export function serializeModVersion(row: ModVersion): SerializedModVersion {
  return {
    id: row.id,
    version: row.version,
    downloadUrl: row.downloadUrl,
    notes: row.notes ?? null,
    releasedAt: row.releasedAt,
    source: isCdnUrl(row.downloadUrl) ? 'hosted' : isGithubComUrl(row.downloadUrl) ? 'github' : 'external',
  };
}

async function attachHostedZipNames(versions: SerializedModVersion[]): Promise<void> {
  const ids = [
    ...new Set(
      versions
        .filter((row) => row.source === 'hosted')
        .map((row) => getFileIdFromCdnUrl(row.downloadUrl))
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (!ids.length) return;
  try {
    const files = await CdnFile.findAll({
      where: {id: ids},
      attributes: ['id', 'metadata'],
    });
    const names = new Map<string, string>();
    for (const file of files) {
      const name = displayNameFromModZipMetadata(file.metadata);
      if (name) names.set(file.id, name);
    }
    for (const row of versions) {
      const id = getFileIdFromCdnUrl(row.downloadUrl);
      if (!id) continue;
      const name = names.get(id);
      if (name) row.originalFilename = name;
    }
  } catch {
    // Catalog payloads still work if CDN metadata is unavailable.
  }
}

export function serializeModBase(mod: Mod, options?: {includeHidden?: boolean}): Omit<
  SerializedMod,
  'assignees' | 'postedBy' | 'tags'
> {
  const payload: Omit<SerializedMod, 'assignees' | 'postedBy' | 'tags'> = {
    id: mod.id,
    slug: mod.slug,
    name: mod.name,
    creatorUsername: mod.creatorUsername,
    creatorDiscordId: mod.creatorDiscordId,
    version: mod.version ?? null,
    description: mod.description ?? null,
    downloadUrl: mod.downloadUrl,
    imageUrl: mod.imageUrl ?? null,
    projectUrl: mod.projectUrl ?? null,
    deprecatedAfter: mod.deprecatedAfter ?? null,
    sourceUploadedAt: mod.sourceUploadedAt,
    isPinned: Boolean(mod.isPinned),
    likes: Number(mod.likes || 0),
    downloadCount: Number(mod.downloadCount || 0),
  };
  if (options?.includeHidden) payload.hidden = Boolean(mod.hidden);
  return payload;
}

export async function serializeMods(
  mods: Mod[],
  options?: {includeHidden?: boolean; includeVersions?: boolean},
): Promise<SerializedMod[]> {
  if (!mods.length) return [];

  const modIds = mods.map((mod) => mod.id);
  const rows = await ModAssignee.findAll({
    where: {modId: modIds},
    attributes: ['modId', 'userId'],
    order: [['id', 'ASC']],
  });

  const userIds = [
    ...rows.map((row) => row.userId),
    ...mods.map((mod) => mod.postedByUserId).filter((id): id is string => Boolean(id)),
  ];
  const [summaries, tagsByModId] = await Promise.all([
    loadUserSummariesByIds(userIds),
    loadTagsByModIds(modIds),
  ]);

  const assigneesByModId = new Map<number, ModUserSummary[]>();
  for (const row of rows) {
    const summary = summaries.get(row.userId);
    if (!summary) continue;
    const list = assigneesByModId.get(row.modId) || [];
    list.push(summary);
    assigneesByModId.set(row.modId, list);
  }

  const versionsByModId = new Map<number, SerializedModVersion[]>();
  if (options?.includeVersions) {
    await Promise.all(
      modIds.map(async (modId) => {
        const versions = await listModVersions(modId);
        versionsByModId.set(modId, versions.map(serializeModVersion));
      }),
    );
    const allVersions: SerializedModVersion[] = [];
    for (const versions of versionsByModId.values()) allVersions.push(...versions);
    await attachHostedZipNames(allVersions);
  }

  return mods.map((mod) => {
    const versions = versionsByModId.get(mod.id);
    const payload: SerializedMod = {
      ...serializeModBase(mod, options),
      tags: tagsByModId.get(mod.id) || [],
      assignees: assigneesByModId.get(mod.id) || [],
      postedBy: mod.postedByUserId ? summaries.get(mod.postedByUserId) || null : null,
    };
    if (versions) {
      payload.versions = versions;
      payload.latestVersion = versions[0] || null;
    }
    return payload;
  });
}

export async function serializeMod(
  mod: Mod,
  options?: {includeHidden?: boolean; includeVersions?: boolean},
): Promise<SerializedMod> {
  const [serialized] = await serializeMods([mod], options);
  return serialized;
}

export async function serializeModDetail(
  mod: Mod,
  options?: {includeHidden?: boolean; selectedVersion?: string | null},
): Promise<SerializedMod> {
  const serialized = await serializeMod(mod, {includeHidden: options?.includeHidden, includeVersions: true});
  if (options?.selectedVersion) {
    const selected = (serialized.versions || []).find((row) => row.version === options.selectedVersion) || null;
    serialized.selectedVersion = selected;
  }
  return serialized;
}
