/** Max ids accepted by GET /levels/references. */
export const LEVEL_REFERENCE_ID_LIMIT = 40;

/**
 * Parse a comma-separated id query into a unique, positive integer list.
 * Stops at {@link LEVEL_REFERENCE_ID_LIMIT}.
 */
export function parseLevelReferenceIds(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return parseLevelReferenceIds(raw.map((part) => String(part)).join(','));
  }
  if (typeof raw !== 'string' || raw.length === 0) {
    return [];
  }

  const ids: number[] = [];
  const seen = new Set<number>();
  for (const part of raw.split(',')) {
    if (ids.length >= LEVEL_REFERENCE_ID_LIMIT) break;
    const id = Number(part.trim());
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export interface LevelReferenceCard {
  id: number;
  diffId: number | null;
  song: string;
  artist: string;
  suffix: string | null;
  toRate: boolean;
  songObject: { name: string } | null;
}

/**
 * Slim card for a comment `#id` mention. Input is an already-decoded level
 * (see {@link convertLevelSearchHit}).
 */
export function toLevelReference(level: Record<string, unknown> | null | undefined): LevelReferenceCard | null {
  if (!level || typeof level.id !== 'number') {
    return null;
  }

  const diffRaw = level.diffId;
  const diffNum = typeof diffRaw === 'number' ? diffRaw : Number(diffRaw);
  const diffId = Number.isInteger(diffNum) && diffNum > 0 ? diffNum : null;

  const songObj = level.songObject;
  const songObject =
    songObj && typeof songObj === 'object'
      ? {
          name:
            (songObj as { name?: unknown }).name != null
              ? String((songObj as { name?: unknown }).name)
              : '',
        }
      : null;

  return {
    id: level.id,
    diffId,
    song: level.song != null ? String(level.song) : '',
    artist: level.artist != null ? String(level.artist) : '',
    suffix: level.suffix != null ? String(level.suffix) : null,
    toRate: level.toRate === true,
    songObject,
  };
}
