import { hasVerifiedEmail } from '@/server/services/accounts/AccountCredentialService.js';

/**
 * Login-time MFA methods. Extend this union (and getAvailableMfaMethods)
 * when adding TOTP / WebAuthn — verify switches on the same list.
 */
export type MfaMethod = 'email';

export const MFA_METHODS = ['email'] as const satisfies readonly MfaMethod[];

/**
 * Which MFA methods the account can currently satisfy.
 * Email is available when the account has a verified inbox.
 */
export function getAvailableMfaMethods(user: {
  email?: string | null;
  permissionFlags?: bigint | number | null;
} | null | undefined): MfaMethod[] {
  if (hasVerifiedEmail(user)) return ['email'];
  return [];
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
