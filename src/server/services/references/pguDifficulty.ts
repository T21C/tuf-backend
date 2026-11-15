export const WATCHABLE_PGU_NAME = /^[PGU][0-9]+$/;

export const REFERENCE_WATCH_GROUPS = ['P', 'G', 'U'] as const;

export type ReferenceWatchGroup = (typeof REFERENCE_WATCH_GROUPS)[number];

export function isWatchablePguDifficultyName(name: string | null | undefined): boolean {
  return typeof name === 'string' && WATCHABLE_PGU_NAME.test(name);
}

export function isReferenceWatchGroup(value: string): value is ReferenceWatchGroup {
  return (REFERENCE_WATCH_GROUPS as readonly string[]).includes(value);
}
