import {hasFlag} from '@/misc/utils/auth/permissionUtils.js';
import type {PermissionInput} from '@/misc/utils/auth/permissionUtils.js';
import {permissionFlags} from '@/config/constants.js';
import type Tournament from '@/models/tournaments/Tournament.js';

export function normalizeOwnerUserIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map(id => String(id ?? '').trim())
        .filter(id => id.length > 0),
    ),
  ];
}

export function isTournamentOwner(
  user: {id?: string | null} | null | undefined,
  tournament: Pick<Tournament, 'ownerUserIds'> | null | undefined,
): boolean {
  if (!user?.id || !tournament) return false;
  const owners = normalizeOwnerUserIds(tournament.ownerUserIds);
  return owners.includes(String(user.id));
}

export function canEditTournamentVisuals(
  user: (PermissionInput & {id?: string | null}) | null | undefined,
  tournament: Pick<Tournament, 'ownerUserIds'> | null | undefined,
): boolean {
  if (!user) return false;
  if (hasFlag(user, permissionFlags.SUPER_ADMIN)) return true;
  return isTournamentOwner(user, tournament);
}
