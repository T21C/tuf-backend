import type Mod from '@/models/misc/Mod.js';

export type SerializedMod = {
  id: number;
  name: string;
  creatorUsername: string;
  creatorDiscordId: string;
  version: string | null;
  description: string | null;
  downloadUrl: string;
  imageUrl: string | null;
  sourceUploadedAt: Date;
  hidden?: boolean;
};

export function serializeMod(mod: Mod, options?: {includeHidden?: boolean}): SerializedMod {
  const payload: SerializedMod = {
    id: mod.id,
    name: mod.name,
    creatorUsername: mod.creatorUsername,
    creatorDiscordId: mod.creatorDiscordId,
    version: mod.version ?? null,
    description: mod.description ?? null,
    downloadUrl: mod.downloadUrl,
    imageUrl: mod.imageUrl ?? null,
    sourceUploadedAt: mod.sourceUploadedAt,
  };
  if (options?.includeHidden) payload.hidden = Boolean(mod.hidden);
  return payload;
}
