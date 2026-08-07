/**
 * OAuth scope bit flags (Authorization Server).
 * Mirror permissionFlags style: (bits & flag) === flag.
 * Mutating scopes are reserved but not in V1_GRANTABLE_SCOPES.
 */

export const oauthScopeFlags = {
  USER_READ_PUBLIC: 1n << 0n,
  USER_READ_EMAIL: 1n << 1n,
  /** Reserved — not grantable in v1 */
  USER_SUBMISSION_CREATE: 1n << 16n,
} as const;

export type OAuthScopeFlag = (typeof oauthScopeFlags)[keyof typeof oauthScopeFlags];

/** Wire names ↔ bits for grantable + reserved (discovery / parsing). */
export const OAUTH_SCOPE_NAME_BY_FLAG: ReadonlyMap<bigint, string> = new Map([
  [oauthScopeFlags.USER_READ_PUBLIC, 'User.Read.Public'],
  [oauthScopeFlags.USER_READ_EMAIL, 'User.Read.Email'],
  [oauthScopeFlags.USER_SUBMISSION_CREATE, 'User.Submission.Create'],
]);

export const OAUTH_SCOPE_FLAG_BY_NAME: ReadonlyMap<string, bigint> = new Map(
  [...OAUTH_SCOPE_NAME_BY_FLAG.entries()].map(([flag, name]) => [name, flag]),
);

/**
 * Scopes clients may request / be granted in v1.
 * Identity-only for now: public profile. Email and mutate remain reserved.
 */
export const V1_GRANTABLE_SCOPES: readonly bigint[] = [
  oauthScopeFlags.USER_READ_PUBLIC,
];

export const V1_GRANTABLE_SCOPE_NAMES: readonly string[] = V1_GRANTABLE_SCOPES.map(
  (f) => OAUTH_SCOPE_NAME_BY_FLAG.get(f)!,
);

export const V1_GRANTABLE_MASK: bigint = V1_GRANTABLE_SCOPES.reduce(
  (acc, f) => acc | f,
  0n,
);

/** Decimal string form of flags — Discord-style permission integers. */
export function scopeFlagToString(flag: bigint): string {
  return flag.toString();
}

export const V1_GRANTABLE_MASK_STRING = scopeFlagToString(V1_GRANTABLE_MASK);

export const OAUTH_SCOPE_FLAGS_WIRE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(oauthScopeFlags).map(([key, flag]) => [key, scopeFlagToString(flag)]),
);

export function hasOAuthScope(bits: bigint, flag: bigint): boolean {
  return (bits & flag) === flag;
}

export function parseScopeString(scope: string | undefined | null): {
  ok: true;
  bits: bigint;
  names: string[];
} | {
  ok: false;
  error: string;
} {
  if (scope == null || String(scope).trim() === '') {
    return { ok: false, error: 'scope is required' };
  }
  const trimmed = String(scope).trim();

  // Discord-style permission integer (decimal bigint).
  if (/^\d+$/.test(trimmed)) {
    let bits: bigint;
    try {
      bits = BigInt(trimmed);
    } catch {
      return { ok: false, error: 'invalid scope bits' };
    }
    if (bits === 0n) {
      return { ok: false, error: 'scope is required' };
    }
    if ((bits & ~V1_GRANTABLE_MASK) !== 0n) {
      return { ok: false, error: 'scope contains non-grantable bits' };
    }
    return { ok: true, bits, names: scopeBitsToNames(bits) };
  }

  const parts = trimmed.split(/\s+/).filter(Boolean);
  const unique = [...new Set(parts)];
  let bits = 0n;
  const names: string[] = [];
  for (const name of unique) {
    const flag = OAUTH_SCOPE_FLAG_BY_NAME.get(name);
    if (flag === undefined) {
      return { ok: false, error: `unknown scope: ${name}` };
    }
    if (!V1_GRANTABLE_SCOPES.includes(flag)) {
      return { ok: false, error: `scope not grantable: ${name}` };
    }
    bits |= flag;
    names.push(name);
  }
  return { ok: true, bits, names };
}

export function scopeBitsToNames(bits: bigint): string[] {
  const names: string[] = [];
  for (const [flag, name] of OAUTH_SCOPE_NAME_BY_FLAG) {
    if (hasOAuthScope(bits, flag) && V1_GRANTABLE_SCOPES.includes(flag)) {
      names.push(name);
    }
  }
  return names;
}

export function scopeBitsToSpaceSeparated(bits: bigint): string {
  return scopeBitsToNames(bits).join(' ');
}

export function parseScopeBitsStored(raw: string | number | bigint | null | undefined): bigint {
  if (raw == null) return 0n;
  if (typeof raw === 'bigint') return raw;
  return BigInt(String(raw));
}
