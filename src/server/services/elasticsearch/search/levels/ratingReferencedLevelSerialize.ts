import { sortLevelCredits } from '@/misc/utils/Utility.js';

function pruneRatingLevelTags(tagsRaw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(tagsRaw)) return [];
  const out: Record<string, unknown>[] = [];
  for (const tag of tagsRaw) {
    const row = tag && typeof tag === 'object' ? (tag as Record<string, unknown>) : null;
    if (row?.id == null) continue;
    const item: Record<string, unknown> = { id: row.id };
    if (row.name != null && String(row.name).length > 0) item.name = String(row.name);
    if (row.icon) item.icon = row.icon;
    if (row.color) item.color = row.color;
    if (row.group != null && row.group !== '') item.group = row.group;
    if (row.sortOrder != null) item.sortOrder = row.sortOrder;
    if (row.groupSortOrder != null) item.groupSortOrder = row.groupSortOrder;
    if (typeof row.score === 'number' && Number.isFinite(row.score)) item.score = row.score;
    if (row.pinned) item.pinned = true;
    if (row.isCommunity) item.isCommunity = true;
    out.push(item);
  }
  return out;
}

function pruneRatingLevelCurations(curationsRaw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(curationsRaw)) return [];
  const out: Record<string, unknown>[] = [];
  for (const curation of curationsRaw) {
    const row = curation && typeof curation === 'object' ? (curation as Record<string, unknown>) : null;
    if (row?.id == null) continue;
    const types = Array.isArray(row.types) ? (row.types as { id?: unknown }[]) : null;
    const typeIds = types
      ? types.map((type) => type?.id).filter((id): id is number => typeof id === 'number' && Number.isFinite(id))
      : Array.isArray(row.typeIds)
        ? (row.typeIds as unknown[]).filter((id): id is number => typeof id === 'number' && Number.isFinite(id))
        : [];
    out.push({ id: row.id, typeIds });
  }
  return out;
}

/**
 * Display-only level payload for the admin rating list cards.
 * Alias trees are omitted — search is server-side via ES.
 *
 * Input must already be decoded via {@link convertLevelSearchHit} (or a plain Sequelize level).
 */
export function pruneLevelForRatingList(
  level: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!level || typeof level.id !== 'number') {
    return null;
  }

  const songObj = level.songObject as Record<string, unknown> | null | undefined;
  const songObject =
    songObj && songObj.id != null
      ? {
          id: songObj.id,
          name: songObj.name != null ? String(songObj.name) : '',
        }
      : null;

  const lcRaw = level.levelCredits as unknown[] | undefined;
  const levelCredits = Array.isArray(lcRaw)
    ? sortLevelCredits(lcRaw as { sortOrder?: number | null; id?: number | null }[]).map((cr) => {
        const row = cr as Record<string, unknown>;
        const c = row?.creator as Record<string, unknown> | null | undefined;
        return {
          role: row.role,
          sortOrder: row.sortOrder,
          ...(row.id != null ? { id: row.id } : {}),
          creator: c
            ? {
                id: c.id,
                name: c.name != null ? String(c.name) : '',
              }
            : null,
        };
      })
    : [];

  const teamObjectRaw = level.teamObject as Record<string, unknown> | null | undefined;
  const teamObject =
    teamObjectRaw && (teamObjectRaw.name != null || teamObjectRaw.id != null)
      ? {
          id: teamObjectRaw.id,
          name: teamObjectRaw.name != null ? String(teamObjectRaw.name) : '',
        }
      : null;

  const teamStr =
    (typeof level.team === 'string' && level.team) ||
    (teamObject?.name ? teamObject.name : null);

  return {
    id: level.id,
    song: level.song,
    artist: level.artist,
    creator: level.creator,
    diffId: level.diffId,
    ppDiffId: level.ppDiffId ?? null,
    baseScore: level.baseScore ?? null,
    ppBaseScore: level.ppBaseScore ?? null,
    xaccCurveMeta: level.xaccCurveMeta ?? null,
    clears: level.clears,
    rerateNum: level.rerateNum,
    rerateReason: level.rerateReason,
    notes: level.notes ?? null,
    suffix: level.suffix ?? null,
    songId: level.songId ?? null,
    team: teamStr,
    videoLink: level.videoLink,
    dlLink: level.dlLink,
    workshopLink: level.workshopLink,
    toRate: level.toRate ?? true,
    fileId: level.fileId ?? null,
    bpm: level.bpm ?? null,
    tilecount: level.tilecount ?? null,
    levelLengthInMs: level.levelLengthInMs ?? null,
    autoTileCount: level.autoTileCount ?? null,
    midspinCount: level.midspinCount ?? null,
    tags: pruneRatingLevelTags(level.tags),
    curations: pruneRatingLevelCurations(
      Array.isArray(level.curations) && level.curations.length
        ? level.curations
        : level.curation
          ? [level.curation]
          : []
    ),
    songObject,
    levelCredits,
    teamObject,
  };
}
