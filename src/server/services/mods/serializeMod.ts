import type Mod from '@/models/misc/Mod.js';
import ModAssignee from '@/models/misc/ModAssignee.js';
import {loadUserSummariesByIds, type ModUserSummary} from './modUsers.js';

export type SerializedMod = {
  id: number;
  name: string;
  creatorUsername: string;
  creatorDiscordId: string;
  version: string | null;
  description: string | null;
  downloadUrl: string;
  imageUrl: string | null;
  projectUrl: string | null;
  sourceUploadedAt: Date;
  hidden?: boolean;
  assignees: ModUserSummary[];
  postedBy: ModUserSummary | null;
};

export function serializeModBase(mod: Mod, options?: {includeHidden?: boolean}): Omit<SerializedMod, 'assignees' | 'postedBy'> {
  const payload: Omit<SerializedMod, 'assignees' | 'postedBy'> = {
    id: mod.id,
    name: mod.name,
    creatorUsername: mod.creatorUsername,
    creatorDiscordId: mod.creatorDiscordId,
    version: mod.version ?? null,
    description: mod.description ?? null,
    downloadUrl: mod.downloadUrl,
    imageUrl: mod.imageUrl ?? null,
    projectUrl: mod.projectUrl ?? null,
    sourceUploadedAt: mod.sourceUploadedAt,
  };
  if (options?.includeHidden) payload.hidden = Boolean(mod.hidden);
  return payload;
}

export async function serializeMods(
  mods: Mod[],
  options?: {includeHidden?: boolean},
): Promise<SerializedMod[]> {
  if (!mods.length) return [];

  const modIds = mods.map((mod) => mod.id);
  const rows = await ModAssignee.findAll({
    where: {modId: modIds},
    attributes: ['modId', 'userId'],
    order: [
      ['id', 'ASC'],
    ],
  });

  const userIds = [
    ...rows.map((row) => row.userId),
    ...mods.map((mod) => mod.postedByUserId).filter((id): id is string => Boolean(id)),
  ];
  const summaries = await loadUserSummariesByIds(userIds);

  const assigneesByModId = new Map<number, ModUserSummary[]>();
  for (const row of rows) {
    const summary = summaries.get(row.userId);
    if (!summary) continue;
    const list = assigneesByModId.get(row.modId) || [];
    list.push(summary);
    assigneesByModId.set(row.modId, list);
  }

  return mods.map((mod) => ({
    ...serializeModBase(mod, options),
    assignees: assigneesByModId.get(mod.id) || [],
    postedBy: mod.postedByUserId ? summaries.get(mod.postedByUserId) || null : null,
  }));
}

export async function serializeMod(mod: Mod, options?: {includeHidden?: boolean}): Promise<SerializedMod> {
  const [serialized] = await serializeMods([mod], options);
  return serialized;
}
