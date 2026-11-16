import {hasVerifiedEmail} from '@/server/services/accounts/AccountCredentialService.js';

/**
 * Login-time MFA methods after a password. Passkeys remain in the union for
 * existing MFA-pending tokens; new challenges only add email and totp.
 */
export type MfaMethod = 'email' | 'totp' | 'passkey';

export const MFA_METHODS = ['email', 'totp'] as const satisfies readonly MfaMethod[];

/**
 * Which MFA methods the account can currently satisfy.
 * Email is available when the account has a verified inbox.
 * TOTP is available when the authenticator has been confirmed.
 */
export function getAvailableMfaMethods(user: {
  id?: string;
  email?: string | null;
  permissionFlags?: bigint | number | null;
  totpEnabled?: boolean | null;
} | null | undefined): MfaMethod[] {
  if (!user?.id) return [];
  const methods: MfaMethod[] = [];
  if (hasVerifiedEmail(user)) methods.push('email');
  if (user.totpEnabled) methods.push('totp');
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
