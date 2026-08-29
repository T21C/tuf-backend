import type {SerializedMod} from '@/server/services/mods/serializeMod.js';
import type {ModUserSummary} from '@/server/services/mods/modUsers.js';

export type ModIndexPerson = {
  userId: string;
  playerId: number | null;
  name: string;
  username: string | null;
};

export type ModIndexDocument = {
  id: number;
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
  creatorUsername?: string | null;
  creatorDiscordId?: string | null;
  description?: string | null;
  projectUrl?: string | null;
  downloadUrl?: string | null;
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
  return [
    mod.name,
    username,
    snowflake,
    dumpLabel,
    mod.description,
    mod.projectUrl,
    mod.downloadUrl,
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
  return {
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
    hidden: Boolean(mod.hidden),
    assignees: mod.assignees || [],
    postedBy: mod.postedBy ?? null,
    searchText: buildModSearchText(mod),
    creatorSortKey: buildModCreatorSortKey(mod),
  };
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
    version: (rest.version as string | null) ?? null,
    description: (rest.description as string | null) ?? null,
    imageUrl: (rest.imageUrl as string | null) ?? null,
    projectUrl: (rest.projectUrl as string | null) ?? null,
    assignees: Array.isArray(rest.assignees) ? rest.assignees : [],
    postedBy: (rest.postedBy as SerializedMod['postedBy']) ?? null,
  } as SerializedMod;
  if (options?.includeHidden) payload.hidden = Boolean(hidden);
  return payload;
}
