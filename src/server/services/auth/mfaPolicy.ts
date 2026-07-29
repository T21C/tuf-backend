import { hasVerifiedEmail } from '@/server/services/accounts/AccountCredentialService.js';
import PasskeyCredential from '@/models/auth/PasskeyCredential.js';

/**
 * Login-time MFA methods. Extend this union (and getAvailableMfaMethods)
 * when adding TOTP — verify switches on the same list.
 */
export type MfaMethod = 'email' | 'passkey';

export const MFA_METHODS = ['email', 'passkey'] as const satisfies readonly MfaMethod[];

/**
 * Which MFA methods the account can currently satisfy.
 * Email is available when the account has a verified inbox.
 * Passkey is available when the account has at least one registered credential.
 */
export async function getAvailableMfaMethods(user: {
  id?: string;
  email?: string | null;
  permissionFlags?: bigint | number | null;
} | null | undefined): Promise<MfaMethod[]> {
  if (!user?.id) return [];
  const methods: MfaMethod[] = [];
  if (hasVerifiedEmail(user)) methods.push('email');
  const passkeyCount = await PasskeyCredential.count({ where: { userId: user.id } });
  if (passkeyCount > 0) methods.push('passkey');
  return methods;
}

/**
 * Pure policy for whether completeAuthentication should challenge MFA.
 * Trusted-device and OAuth exemption are inputs so the matrix is unit-testable.
 */
export function shouldChallengeMfa(opts: {
  mfaExempt: boolean;
  isTrustedDevice: boolean;
  methods: readonly MfaMethod[];
}): boolean {
  if (opts.mfaExempt) return false;
  if (opts.isTrustedDevice) return false;
  return opts.methods.length > 0;
}
