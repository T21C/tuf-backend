import { sortLevelCredits } from '@/misc/utils/Utility.js';

function normalizeFileId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * LevelCard hydrates catalog fields from tagsDict, but pack cards still need a
 * display name (letter fallback) plus assignment overlay (score/pinned).
 * ID-only rows crash the client when the catalog is empty or missing that id.
 */
function prunePackReferencedLevelTag(t: unknown): Record<string, unknown> | null {
  const row = t && typeof t === 'object' ? (t as Record<string, unknown>) : null;
  if (row?.id == null) return null;

  const name = row.name != null ? String(row.name) : '';
  const scoreRaw = row.score;
  const out: Record<string, unknown> = { id: row.id };
  if (name) out.name = name;
  if (row.icon) out.icon = row.icon;
  if (row.color) out.color = row.color;
  if (row.group != null && row.group !== '') out.group = row.group;
  if (row.sortOrder != null) out.sortOrder = row.sortOrder;
  if (row.groupSortOrder != null) out.groupSortOrder = row.groupSortOrder;
  if (typeof scoreRaw === 'number' && Number.isFinite(scoreRaw)) out.score = scoreRaw;
  if (row.pinned) out.pinned = true;
  if (row.isCommunity) out.isCommunity = true;
  return out;
}

/**
 * Minimal `referencedLevel` payload for pack tree UI (LevelCard pack mode + creator line).
 * Omits ES/MySQL bloat (level aliases, full song objects, nested search fields, etc.).
 *
 * Input must be an **already-decoded** level object — either a Sequelize `referencedLevel`
 * (e.g. PUT /packs/:id/tree response) or an ES hit run through `convertLevelSearchHit`.
 * Creator rows include only `name` (no creator alias lists).
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
    ? (tagsRaw.map(prunePackReferencedLevelTag).filter(Boolean) as Record<string, unknown>[])
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
    ? sortLevelCredits(lcRaw as { sortOrder?: number | null; id?: number | null }[]).map((cr) => {
        const row = cr as Record<string, unknown>;
        const c = row?.creator as Record<string, unknown> | null | undefined;
        return {
          role: row.role,
          sortOrder: row.sortOrder,
          ...(row.id != null ? { id: row.id } : {}),
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
    fileId: normalizeFileId(level.fileId),
    videoLink: level.videoLink,
    dlLink: level.dlLink,
    workshopLink: level.workshopLink,
    ws: level.ws,
    clears: level.clears,
    uniqueClears: level.uniqueClears,
    likes: level.likes,
    isDeleted: level.isDeleted,
    isHidden: level.isHidden,
  };
}
