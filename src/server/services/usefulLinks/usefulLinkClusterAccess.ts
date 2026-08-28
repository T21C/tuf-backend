export const UsefulLinkClusterViewModes = {
  PUBLIC: 1,
  LINKONLY: 2,
  PRIVATE: 3,
} as const;

export type UsefulLinkClusterViewMode =
  (typeof UsefulLinkClusterViewModes)[keyof typeof UsefulLinkClusterViewModes];

export const DEFAULT_MAX_CLUSTERS_PER_USER = 20;
export const TUF_STELLAR_MAX_CLUSTERS_PER_USER = 100;
export const DEFAULT_MAX_ITEMS_PER_CLUSTER = 250;
export const TUF_STELLAR_MAX_ITEMS_PER_CLUSTER = 250;

type UserLike = {id?: string; permissionFlags?: string | number | bigint} | null | undefined;

function userIdOf(user: UserLike): string | null {
  return user && typeof user.id === 'string' ? user.id : null;
}

export function isSuperAdminUser(user: UserLike, hasFlag: (u: unknown, flag: bigint) => boolean, flag: bigint): boolean {
  return Boolean(user && hasFlag(user, flag));
}

export function canViewCluster(
  cluster: {ownerId: string; viewMode: number},
  user: UserLike,
  hasFlag: (u: unknown, flag: bigint) => boolean,
  superAdminFlag: bigint,
): boolean {
  if (!cluster) return false;
  const uid = userIdOf(user);
  if (uid && cluster.ownerId === uid) return true;
  if (user && hasFlag(user, superAdminFlag)) return true;
  return (
    cluster.viewMode === UsefulLinkClusterViewModes.PUBLIC ||
    cluster.viewMode === UsefulLinkClusterViewModes.LINKONLY
  );
}

export function canEditCluster(
  cluster: {ownerId: string; viewMode: number},
  user: UserLike,
  hasFlag: (u: unknown, flag: bigint) => boolean,
  superAdminFlag: bigint,
): boolean {
  if (!user || !cluster) return false;
  if (hasFlag(user, superAdminFlag)) return true;
  const uid = userIdOf(user);
  if (!uid || cluster.ownerId !== uid) return false;
  return cluster.viewMode !== UsefulLinkClusterViewModes.PUBLIC;
}

export function ownerMaySetViewMode(from: number, to: number): boolean {
  const mutable = new Set<number>([
    UsefulLinkClusterViewModes.PRIVATE,
    UsefulLinkClusterViewModes.LINKONLY,
  ]);
  return mutable.has(from) && mutable.has(to);
}

export function isPublishTransition(from: number, to: number): boolean {
  return to === UsefulLinkClusterViewModes.PUBLIC && from !== UsefulLinkClusterViewModes.PUBLIC;
}
