import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeBase32,
  encodeBase32,
  generateRecoveryCodes,
  hashRecoveryCode,
  hotp,
  isTotpCode,
  normalizeRecoveryCode,
  totpAt,
  verifyTotp,
} from './totp.js';

// RFC 6238 Appendix B SHA-1 secret (ASCII).
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

void test('encodeBase32 round-trips 20 secret bytes', () => {
  const bytes = Buffer.from('12345678901234567890', 'ascii');
  const encoded = encodeBase32(bytes);
  assert.equal(encoded.includes('='), false);
  assert.deepEqual(decodeBase32(encoded).subarray(0, bytes.length), bytes);
});

void test('RFC 6238 SHA-1 TOTP 6-digit vectors', () => {
  const cases: Array<[number, string]> = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];
  for (const [unix, expected] of cases) {
    assert.equal(totpAt(RFC_SECRET, unix), expected);
    assert.equal(hotp(RFC_SECRET, Math.floor(unix / 30)), expected);
  }
});

void test('verifyTotp accepts the current step and rejects reuse of that step', () => {
  const now = 1111111111;
  const code = totpAt(RFC_SECRET, now);
  const first = verifyTotp({secret: RFC_SECRET, code, now});
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = verifyTotp({
    secret: RFC_SECRET,
    code,
    now,
    lastAcceptedStep: first.step,
  });
  assert.equal(second.ok, false);
});

void test('verifyTotp accepts one step of clock skew', () => {
  const now = 1111111111;
  const previous = totpAt(RFC_SECRET, now - 30);
  const result = verifyTotp({secret: RFC_SECRET, code: previous, now});
  assert.equal(result.ok, true);
});

void test('isTotpCode only matches six digits', () => {
  assert.equal(isTotpCode('123456'), true);
  assert.equal(isTotpCode('12 34 56'), true);
  assert.equal(isTotpCode('12345'), false);
  assert.equal(isTotpCode('ABCDE-FGHIJ'), false);
});

void test('recovery code hash is user-bound and format-insensitive', () => {
  const code = 'ABCDE-FGHIJ';
  assert.equal(normalizeRecoveryCode('abcde fghij'), 'ABCDEFGHIJ');
  assert.equal(
    hashRecoveryCode('user-a', code),
    hashRecoveryCode('user-a', 'abcdefghij'),
  );
  assert.notEqual(hashRecoveryCode('user-a', code), hashRecoveryCode('user-b', code));
});

void test('generateRecoveryCodes returns ten unique dashed codes', () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) {
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  }
});
