import type {SerializedMod} from '@/server/services/mods/serializeMod.js';
import type {ModUserSummary} from '@/server/services/mods/modUsers.js';
import type {SerializedModTag} from '@/server/services/mods/modTags.js';

export type ModIndexPerson = {
  userId: string;
  playerId: number | null;
  name: string;
  username: string | null;
};

export type ModIndexTag = {
  id: number;
  name: string;
  color: string;
};

export type ModIndexDocument = {
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
  sourceUploadedAt: string | Date;
  hidden: boolean;
  isPinned: boolean;
  likes: number;
  downloadCount: number;
  tags: ModIndexTag[];
  assignees: ModIndexPerson[];
  postedBy: ModIndexPerson | null;
  searchText: string;
  creatorSortKey: string;
};

function personBits(person: ModUserSummary | ModIndexPerson | null | undefined): string[] {
  if (!person) return [];
  return [person.name, person.username].filter((value): value is string => Boolean(value));
}

export function buildModSearchText(mod: {
  name?: string | null;
  slug?: string | null;
  creatorUsername?: string | null;
  creatorDiscordId?: string | null;
  description?: string | null;
  projectUrl?: string | null;
  downloadUrl?: string | null;
  version?: string | null;
  tags?: Array<SerializedModTag | ModIndexTag | null> | null;
  assignees?: Array<ModUserSummary | ModIndexPerson | null> | null;
  postedBy?: ModUserSummary | ModIndexPerson | null;
}): string {
  const username = mod.creatorUsername || '';
  const snowflake = mod.creatorDiscordId || '';
  const dumpLabel = username && snowflake ? `${username} @${snowflake}` : username || snowflake;
  const people = [
    ...(Array.isArray(mod.assignees) ? mod.assignees : []),
    mod.postedBy,
  ];
  const tagNames = (Array.isArray(mod.tags) ? mod.tags : [])
    .map((tag) => tag?.name)
    .filter((value): value is string => Boolean(value));
  return [
    mod.name,
    mod.slug,
    mod.version,
    username,
    snowflake,
    dumpLabel,
    mod.description,
    mod.projectUrl,
    mod.downloadUrl,
    ...tagNames,
    ...people.flatMap(personBits),
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('\n');
}

export function buildModCreatorSortKey(mod: {
  creatorUsername?: string | null;
  assignees?: Array<ModUserSummary | ModIndexPerson | null> | null;
  postedBy?: ModUserSummary | ModIndexPerson | null;
}): string {
  const posted = mod.postedBy?.name?.trim();
  if (posted) return posted;
  const assigned = (Array.isArray(mod.assignees) ? mod.assignees : []).find(
    (person) => person?.name?.trim(),
  );
  if (assigned?.name) return assigned.name.trim();
  return String(mod.creatorUsername || '').trim();
}

export function buildModIndexDocument(mod: SerializedMod): ModIndexDocument {
  const tags = (mod.tags || []).map((tag) => ({
    id: tag.id,
    name: tag.name,
    color: tag.color,
  }));
  return {
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
    sourceUploadedAt: mod.sourceUploadedAt,
    hidden: Boolean(mod.hidden),
    isPinned: Boolean(mod.isPinned),
    likes: Number(mod.likes || 0),
    downloadCount: Number(mod.downloadCount || 0),
    tags,
    assignees: mod.assignees || [],
    postedBy: mod.postedBy ?? null,
    searchText: buildModSearchText({...mod, tags}),
    creatorSortKey: buildModCreatorSortKey(mod),
  };
}

function asTagList(raw: unknown): SerializedModTag[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const id = Number(row.id);
      if (!Number.isInteger(id) || id <= 0) return null;
      return {
        id,
        name: String(row.name || ''),
        color: String(row.color || '#8d70ff'),
        sortOrder: Number(row.sortOrder || 0),
      };
    })
    .filter((tag): tag is SerializedModTag => Boolean(tag));
}

export function serializedModFromIndexSource(
  source: Record<string, unknown>,
  options?: {includeHidden?: boolean},
): SerializedMod {
  const {
    searchText: _searchText,
    creatorSortKey: _creatorSortKey,
    hidden,
    ...rest
  } = source as Record<string, unknown> & {
    hidden?: unknown;
    searchText?: unknown;
    creatorSortKey?: unknown;
  };
  const payload = {
    ...rest,
    slug: String(rest.slug || ''),
    version: (rest.version as string | null) ?? null,
    description: (rest.description as string | null) ?? null,
    imageUrl: (rest.imageUrl as string | null) ?? null,
    projectUrl: (rest.projectUrl as string | null) ?? null,
    isPinned: Boolean(rest.isPinned),
    likes: Number(rest.likes || 0),
    downloadCount: Number(rest.downloadCount || 0),
    tags: asTagList(rest.tags),
    assignees: Array.isArray(rest.assignees) ? rest.assignees : [],
    postedBy: (rest.postedBy as SerializedMod['postedBy']) ?? null,
  } as SerializedMod;
  if (options?.includeHidden) payload.hidden = Boolean(hidden);
  return payload;
}
