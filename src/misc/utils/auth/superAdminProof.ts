import crypto from 'crypto';

export const SUPER_ADMIN_PROOF_MAX_SKEW_SEC = 5 * 60;

export type SuperAdminProofInput = {
  secret: string;
  userId: string;
  username: string;
  method: string;
  path: string;
  unixSeconds: number;
};

function normalizeMethod(method: string): string {
  return String(method || '').toUpperCase();
}

export function normalizeSuperAdminProofPath(path: string): string {
  const raw = String(path || '').split('?')[0];
  if (!raw) return '/';
  try {
    if (/^https?:\/\//i.test(raw)) {
      return new URL(raw).pathname || '/';
    }
  } catch {
    /* keep raw path */
  }
  return raw.startsWith('/') ? raw : `/${raw}`;
}

export function superAdminProofMessage(params: SuperAdminProofInput): string {
  return [
    'v1',
    params.userId,
    params.username,
    normalizeMethod(params.method),
    normalizeSuperAdminProofPath(params.path),
    String(params.unixSeconds),
  ].join('\n');
}

function hmacDigest(secret: string, message: string): Buffer {
  return crypto.createHmac('sha256', secret).update(message, 'utf8').digest();
}

export function createSuperAdminProof(params: SuperAdminProofInput): string {
  const hex = hmacDigest(params.secret, superAdminProofMessage(params)).toString('hex');
  return `v1.${params.unixSeconds}.${hex}`;
}

function parseProof(proof: string): { unixSeconds: number; digest: Buffer } | null {
  const parts = String(proof || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const unixSeconds = Number(parts[1]);
  if (!Number.isInteger(unixSeconds) || unixSeconds <= 0) return null;
  const hex = parts[2];
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  return { unixSeconds, digest: Buffer.from(hex, 'hex') };
}

export function verifySuperAdminProof(params: {
  proof: string;
  secret: string;
  userId: string;
  username: string;
  method: string;
  path: string;
  now?: number;
}): boolean {
  if (!params.secret) return false;
  const parsed = parseProof(params.proof);
  if (!parsed || parsed.digest.length !== 32) return false;

  const now = params.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.unixSeconds) > SUPER_ADMIN_PROOF_MAX_SKEW_SEC) {
    return false;
  }

  const expected = hmacDigest(
    params.secret,
    superAdminProofMessage({
      secret: params.secret,
      userId: params.userId,
      username: params.username,
      method: params.method,
      path: params.path,
      unixSeconds: parsed.unixSeconds,
    }),
  );
  if (expected.length !== parsed.digest.length) return false;
  return crypto.timingSafeEqual(expected, parsed.digest);
}
