import User from '@/models/auth/User.js';
import { hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import { permissionFlags } from '@/config/constants.js';
import { accountCredentialService } from '@/server/services/accounts/AccountCredentialService.js';

/**
 * Public user fields returned after login / register / refresh / OAuth.
 * Superset of the former controller-local serializer so password and OAuth
 * paths share one contract.
 */
export function publicUserFields(user: User) {
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname ?? null,
    email: user.email ?? null,
    pendingEmail: user.pendingEmail ?? null,
    emailResendAvailableAt:
      accountCredentialService.getEmailResendAvailableAt(user)?.toISOString() ?? null,
    avatarUrl: user.avatarUrl ?? null,
    playerId: user.playerId ?? null,
    creatorId: user.creatorId ?? null,
    isRater: hasFlag(user, permissionFlags.RATER),
    isSuperAdmin: hasFlag(user, permissionFlags.SUPER_ADMIN),
    isEmailVerified: hasFlag(user, permissionFlags.EMAIL_VERIFIED),
    permissionFlags: user.permissionFlags.toString(),
  };
}

export type PublicUserFields = ReturnType<typeof publicUserFields>;
