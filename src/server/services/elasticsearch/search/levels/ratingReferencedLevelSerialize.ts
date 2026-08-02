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
    ? lcRaw.map((cr) => {
        const row = cr as Record<string, unknown>;
        const c = row?.creator as Record<string, unknown> | null | undefined;
        return {
          role: row.role,
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
    clears: level.clears,
    rerateNum: level.rerateNum,
    rerateReason: level.rerateReason,
    suffix: level.suffix ?? null,
    songId: level.songId ?? null,
    team: teamStr,
    videoLink: level.videoLink,
    dlLink: level.dlLink,
    workshopLink: level.workshopLink,
    toRate: level.toRate ?? true,
    songObject,
    levelCredits,
    teamObject,
  };
}
