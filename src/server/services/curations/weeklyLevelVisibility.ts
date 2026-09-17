/** A weekly slot is only public when its level still exists and is not deleted or hidden. */
export function isWeeklyLevelPublic(
  level: { isDeleted?: boolean | null; isHidden?: boolean | null } | null | undefined,
): boolean {
  if (!level) return false;
  return !level.isDeleted && !level.isHidden;
}
