export type LevelIndexTag = {
  id: number;
  name: unknown;
  icon: unknown;
  color: unknown;
  group: unknown;
  score: number | null;
  pinned: boolean;
  isCommunity: boolean;
};

function plainRow<T extends object>(row: T): Record<string, unknown> {
  const m = row as unknown as { get?: (opts: { plain: true }) => unknown };
  if (typeof m.get === 'function') {
    return m.get({ plain: true }) as Record<string, unknown>;
  }
  return { ...(row as Record<string, unknown>) };
}

/** Flatten assignment/tag rows into the nested ES tag shape used by level and pass indexes. */
export function projectLevelTagsForIndex(tags: unknown): LevelIndexTag[] {
  if (!Array.isArray(tags)) return [];
  return tags.map((tag: any) => {
    const t = plainRow(tag as object) as any;
    const groupName = t.tagGroup?.name ?? t.group ?? null;
    const through = t.LevelTagAssignment || t.level_tag_assignment || {};
    const scoreRaw =
      typeof tag.score === 'number'
        ? tag.score
        : typeof t.score === 'number'
          ? t.score
          : through.score;
    return {
      id: t.id,
      name: t.name,
      icon: t.icon,
      color: t.color,
      group: groupName,
      score: typeof scoreRaw === 'number' && Number.isFinite(scoreRaw) ? scoreRaw : null,
      pinned: Boolean(tag.pinned ?? t.pinned ?? through.pinned),
      isCommunity: Boolean(tag.isCommunity ?? t.isCommunity),
    };
  });
}
