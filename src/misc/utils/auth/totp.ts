import crypto from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SEC = 30;
export const TOTP_WINDOW = 1;
export const TOTP_ISSUER = 'TUF';
const SECRET_BYTES = 20;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_CHARS = 10;

export function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32[(value << (5 - bits)) & 31];
  }
  return output;
}

export function decodeBase32(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) {
      throw new Error('Invalid base32');
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): {bytes: Buffer; base32: string} {
  const bytes = crypto.randomBytes(SECRET_BYTES);
  return {bytes, base32: encodeBase32(bytes)};
}

export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  const mod = 10 ** digits;
  return String(bin % mod).padStart(digits, '0');
}

export function totpAt(
  secret: Buffer,
  unixSeconds: number,
  digits = TOTP_DIGITS,
  period = TOTP_PERIOD_SEC,
): string {
  const step = Math.floor(unixSeconds / period);
  return hotp(secret, step, digits);
}

export function normalizeTotpCode(code: string): string {
  return code.replace(/\s+/g, '');
}

export function isTotpCode(code: string): boolean {
  return /^\d{6}$/.test(normalizeTotpCode(code));
}

function codesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function asStep(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

export function verifyTotp(opts: {
  secret: Buffer;
  code: string;
  now?: number;
  lastAcceptedStep?: number | null;
  window?: number;
}): {ok: true; step: number} | {ok: false} {
  const normalized = normalizeTotpCode(opts.code);
  if (!/^\d{6}$/.test(normalized)) return {ok: false};

  const nowSec = opts.now ?? Date.now() / 1000;
  const window = opts.window ?? TOTP_WINDOW;
  const current = Math.floor(nowSec / TOTP_PERIOD_SEC);
  const lastAccepted = asStep(opts.lastAcceptedStep);

  let matchedStep: number | null = null;
  for (let delta = -window; delta <= window; delta += 1) {
    const step = current + delta;
    if (step < 0) continue;
    const expected = hotp(opts.secret, step);
    if (codesEqual(expected, normalized)) {
      matchedStep = step;
    }
  }

  if (matchedStep == null) return {ok: false};
  if (lastAccepted != null && matchedStep <= lastAccepted) return {ok: false};
  return {ok: true, step: matchedStep};
}

export function buildOtpauthUri(opts: {
  issuer?: string;
  account: string;
  secretBase32: string;
}): string {
  const issuer = opts.issuer || TOTP_ISSUER;
  const account = opts.account.trim() || 'user';
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: opts.secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SEC),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function hashRecoveryCode(userId: string, code: string): string {
  const normalized = normalizeRecoveryCode(code);
  return crypto.createHash('sha256').update(`totp-recovery:${userId}:${normalized}`).digest('hex');
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  const seen = new Set<string>();
  while (codes.length < count) {
    const bytes = crypto.randomBytes(RECOVERY_CODE_CHARS);
    let raw = '';
    for (let i = 0; i < RECOVERY_CODE_CHARS; i += 1) {
      raw += CROCKFORD[bytes[i]! % CROCKFORD.length];
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}
