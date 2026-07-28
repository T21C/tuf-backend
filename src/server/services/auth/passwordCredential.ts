/**
 * Single, auditable way to read a stored password hash.
 *
 * `req.user` omits credential columns (see REQUEST_USER_ATTRIBUTES in
 * middleware/auth.ts), so handlers that must verify a current password or test
 * whether a password exists load the hash here for exactly one user instead of
 * relying on a fully-hydrated user row travelling through the request.
 */
import User from '@/models/auth/User.js';

/** The stored hash for one user, or null when the account is OAuth-only. */
export async function loadPasswordHash(userId: string): Promise<string | null> {
  // This file is the sanctioned exemption to tuf/no-unsafe-user-include; see
  // the overrides block in .eslintrc.security.cjs.
  const row = await User.findByPk(userId, {
    attributes: ['id', 'password'],
  });
  return row?.password ?? null;
}

/** Whether the account has a usable password credential. */
export async function hasPasswordCredential(userId: string): Promise<boolean> {
  return (await loadPasswordHash(userId)) !== null;
}
