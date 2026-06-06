import { convertFromPUA, decodePuaTextOrNull } from '@/misc/utils/data/searchHelpers.js';

function decodeText(value: unknown): string | null {
  return decodePuaTextOrNull(value);
}

/**
 * Minimal level payload for pack tree UI (LevelCard pack mode + creator line).
 * Omits ES index bloat (level aliases, full song objects, nested search fields, etc.).
 * Creator rows include only `name` (no creator alias lists).
 */
export function buildPackReferencedLevelFromEsSource(src: Record<string, unknown>): Record<string, unknown> {
  const id = typeof src.id === 'number' ? src.id : parseInt(String(src.id), 10);
  const rating = src.rating as Record<string, unknown> | undefined;
  const ratingOut =
    rating && rating.averageDifficultyId != null
      ? { averageDifficultyId: rating.averageDifficultyId }
      : undefined;

  const tagsRaw = src.tags as unknown[] | undefined;
  const tags = Array.isArray(tagsRaw)
    ? (tagsRaw
        .map((t) => {
          const row = t as Record<string, unknown>;
          return row?.id != null ? { id: row.id } : null;
        })
        .filter(Boolean) as { id: unknown }[])
    : [];

  const curationsRaw = src.curations as unknown[] | undefined;
  const curations = Array.isArray(curationsRaw)
    ? (curationsRaw
        .map((c) => {
          const row = c as Record<string, unknown>;
          if (row?.id == null) return null;
          const typeIdsRaw = row.typeIds;
          const typeIds = Array.isArray(typeIdsRaw)
            ? typeIdsRaw.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
            : [];
          const themeTypeId =
            typeof row.themeTypeId === 'number' && Number.isFinite(row.themeTypeId)
              ? row.themeTypeId
              : undefined;
          return { id: row.id, typeIds, ...(themeTypeId != null ? { themeTypeId } : {}) };
        })
        .filter(Boolean) as Record<string, unknown>[])
    : [];

  const lcRaw = src.levelCredits as unknown[] | undefined;
  const levelCredits = Array.isArray(lcRaw)
    ? lcRaw.map((cr) => {
        const row = cr as Record<string, unknown>;
        const c = row?.creator as Record<string, unknown> | null | undefined;
        return {
          role: row.role,
          creator: c ? { name: decodeText(c.name as string) ?? '' } : null,
        };
      })
    : [];

  const songObj = src.songObject as Record<string, unknown> | null | undefined;
  const songObject =
    songObj && songObj.id != null
      ? {
          id: songObj.id,
          name: decodeText(songObj.name as string) ?? '',
        }
      : null;

  const artistsRaw = src.artists as unknown[] | undefined;
  const artists = Array.isArray(artistsRaw)
    ? artistsRaw.map((a) => ({
        name: decodeText((a as Record<string, unknown>)?.name as string) ?? '',
      }))
    : null;

  const teamStr =
    typeof src.team === 'string'
      ? decodeText(src.team)
      : src.team != null
        ? decodeText(String(src.team))
        : null;

  return {
    _packViewMinimal: true,
    id,
    diffId: src.diffId,
    tilecount: src.tilecount,
    bpm: src.bpm,
    levelLengthInMs: src.levelLengthInMs,
    baseScore: src.baseScore,
    song: decodeText(src.song as string),
    artist: decodeText(src.artist as string),
    suffix: decodePuaTextOrNull(src.suffix),
    songId: src.songId ?? null,
    songObject,
    artists,
    team: teamStr,
    levelCredits,
    tags,
    curations,
    rating: ratingOut,
    videoLink: decodeText(src.videoLink as string),
    dlLink: decodeText(src.dlLink as string),
    workshopLink: src.workshopLink != null ? decodeText(src.workshopLink as string) : null,
    ws: src.ws != null ? decodeText(src.ws as string) : null,
    clears: src.clears,
    uniqueClears: src.uniqueClears,
    isDeleted: src.isDeleted,
    isHidden: src.isHidden,
  };
}

/**
 * Same wire shape as {@link buildPackReferencedLevelFromEsSource} for Sequelize `referencedLevel` JSON
 * (e.g. PUT /packs/:id/tree response) without heavy nested curation/tag payloads.
 */
export function pruneMysqlReferencedLevelForPack(
  level: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!level || typeof level.id !== 'number') {
    return null;
  }

  const rating = level.rating as Record<string, unknown> | undefined;
  const ratingOut =
    rating && rating.averageDifficultyId != null
      ? { averageDifficultyId: rating.averageDifficultyId }
      : undefined;

  const tagsRaw = level.tags as unknown[] | undefined;
  const tags = Array.isArray(tagsRaw)
    ? (tagsRaw
        .map((t) => {
          const row = t as Record<string, unknown>;
          return row?.id != null ? { id: row.id } : null;
        })
        .filter(Boolean) as { id: unknown }[])
    : [];

  const curationsRaw = level.curations as unknown[] | undefined;
  const curations = Array.isArray(curationsRaw)
    ? (curationsRaw
        .map((c) => {
          const row = c as Record<string, unknown>;
          if (row?.id == null) return null;
          const types = row.types as { id: number }[] | undefined;
          const typeIds = Array.isArray(types)
            ? types.map((t) => t.id).filter((id) => typeof id === 'number' && Number.isFinite(id))
            : Array.isArray(row.typeIds)
              ? (row.typeIds as number[]).filter((id) => typeof id === 'number' && Number.isFinite(id))
              : [];
          const themeTypeId =
            typeof row.themeTypeId === 'number' && Number.isFinite(row.themeTypeId)
              ? row.themeTypeId
              : undefined;
          return { id: row.id, typeIds, ...(themeTypeId != null ? { themeTypeId } : {}) };
        })
        .filter(Boolean) as Record<string, unknown>[])
    : [];

  const lcRaw = level.levelCredits as unknown[] | undefined;
  const levelCredits = Array.isArray(lcRaw)
    ? lcRaw.map((cr) => {
        const row = cr as Record<string, unknown>;
        const c = row?.creator as Record<string, unknown> | null | undefined;
        return {
          role: row.role,
          creator: c ? { name: c.name != null ? String(c.name) : '' } : null,
        };
      })
    : [];

  const songObj = level.songObject as Record<string, unknown> | null | undefined;
  const songObject =
    songObj && songObj.id != null
      ? { id: songObj.id, name: songObj.name != null ? String(songObj.name) : '' }
      : null;

  const artistsRaw = level.artists as unknown[] | undefined;
  const artists = Array.isArray(artistsRaw)
    ? artistsRaw.map((a) => ({
        name: String((a as Record<string, unknown>)?.name ?? ''),
      }))
    : null;

  const teamObject = level.teamObject as Record<string, unknown> | null | undefined;
  const teamStr =
    (typeof level.team === 'string' && level.team) ||
    (teamObject?.name != null ? String(teamObject.name) : null);

  return {
    _packViewMinimal: true,
    id: level.id,
    diffId: level.diffId,
    tilecount: level.tilecount,
    bpm: level.bpm,
    levelLengthInMs: level.levelLengthInMs,
    baseScore: level.baseScore,
    song: level.song,
    artist: level.artist,
    suffix: level.suffix ?? null,
    songId: level.songId ?? null,
    songObject,
    artists,
    team: teamStr,
    levelCredits,
    tags,
    curations,
    rating: ratingOut,
    videoLink: level.videoLink,
    dlLink: level.dlLink,
    workshopLink: level.workshopLink,
    ws: level.ws,
    clears: level.clears,
    uniqueClears: level.uniqueClears,
    isDeleted: level.isDeleted,
    isHidden: level.isHidden,
  };
}
