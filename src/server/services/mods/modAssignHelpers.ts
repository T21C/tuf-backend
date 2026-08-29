export function otherModIdsForSameCreator(
  current: {id: number; creatorDiscordId: string},
  allMods: {id: number; creatorDiscordId: string}[],
  alreadyAssignedModIds: Set<number>,
): number[] {
  return allMods
    .filter(
      (mod) =>
        mod.id !== current.id &&
        mod.creatorDiscordId === current.creatorDiscordId &&
        !alreadyAssignedModIds.has(mod.id),
    )
    .map((mod) => mod.id);
}

export function postedByAfterUnassign(
  postedByUserId: string | null | undefined,
  unassignedUserId: string,
): string | null {
  if (!postedByUserId) return null;
  return postedByUserId === unassignedUserId ? null : postedByUserId;
}
