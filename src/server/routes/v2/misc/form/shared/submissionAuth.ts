import type { Request } from 'express';
import { hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import { permissionFlags } from '@/config/constants.js';
import { isPermissionBanActive } from '@/server/services/accounts/playerBanUtils.js';
import { formError } from './errors.js';

/**
 * Shared submission permission gate. Every form/submit endpoint must pass this
 * before doing any work. Centralised so new endpoints can't forget a check.
 *
 * Throws a {@link FormError} with the appropriate status code; never mutates req.
 */
export function gateSubmission(req: Request): { userId: string } {
  if (!req.user) throw formError.unauth();
  if (isPermissionBanActive(req.user, req.user.player?.bannedUntil)) {
    throw formError.forbid('You are banned');
  }
  if (hasFlag(req.user, permissionFlags.SUBMISSIONS_PAUSED)) throw formError.forbid('Your submissions are paused');
  if (!hasFlag(req.user, permissionFlags.EMAIL_VERIFIED)) throw formError.forbid('Your email is not verified');
  return { userId: req.user.id };
}
