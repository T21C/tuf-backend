import type { UserAttributes } from '@/models/auth/User.js';
import { hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import { permissionFlags } from '@/config/constants.js';
import { isPermissionBanActive } from '@/server/services/accounts/playerBanUtils.js';
import { formError } from './submissionErrors.js';

export function gateSubmissionUser(user: UserAttributes | null | undefined): { userId: string } {
  if (!user) throw formError.unauth();
  if (isPermissionBanActive(user, user.player?.bannedUntil)) {
    throw formError.forbid('You are banned');
  }
  if (hasFlag(user, permissionFlags.SUBMISSIONS_PAUSED)) throw formError.forbid('Your submissions are paused');
  if (!hasFlag(user, permissionFlags.EMAIL_VERIFIED)) throw formError.forbid('Your email is not verified');
  return { userId: user.id };
}
