import {permissionFlags} from '@/config/constants.js';

type PermissionCarrier =
  | {permissionFlags?: string | number | bigint | null}
  | string
  | number
  | bigint
  | null
  | undefined;

function readFlags(user: PermissionCarrier): bigint {
  if (user == null) return 0n;
  if (typeof user === 'object') return BigInt(user.permissionFlags ?? 0);
  return BigInt(user || 0);
}

function has(user: PermissionCarrier, permission: bigint): boolean {
  const flags = readFlags(user);
  return (flags & permission) === permission;
}

/** Head curator and super admin may post curation announcements. */
export function canAnnounceCurations(user: PermissionCarrier): boolean {
  return has(user, permissionFlags.HEAD_CURATOR) || has(user, permissionFlags.SUPER_ADMIN);
}

/**
 * Super admins can use every announcement kind.
 * Head curators can use new curations and curation rerates only.
 */
export function canAccessAnnouncementKind(user: PermissionCarrier, kind: string): boolean {
  if (has(user, permissionFlags.SUPER_ADMIN)) return true;
  return canAnnounceCurations(user) && (kind === 'curation' || kind === 'curation_rerate');
}
