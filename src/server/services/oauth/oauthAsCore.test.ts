import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseScopeString,
  scopeBitsToNames,
  scopeBitsToSpaceSeparated,
  hasOAuthScope,
  oauthScopeFlags,
  V1_GRANTABLE_MASK,
} from '@/config/oauthScopes.js';
import {
  assertValidRedirectUri,
  isRedirectUriAllowed,
  OAuthClientError,
} from '@/server/services/oauth/OAuthClientService.js';
import {
  verifyPkce,
  mintOAuthAccessToken,
  verifyOAuthAccessToken,
  scopesMatch,
} from '@/server/services/oauth/OAuthTokenService.js';
import { tokenUtils } from '@/misc/utils/auth/auth.js';
import crypto from 'crypto';

test('parseScopeString accepts grantable scopes and rejects mutate / unknown', () => {
  const ok = parseScopeString('User.Read.Public');
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.ok(hasOAuthScope(ok.bits, oauthScopeFlags.USER_READ_PUBLIC));
    assert.equal(scopeBitsToSpaceSeparated(ok.bits), 'User.Read.Public');
  }

  const asBits = parseScopeString(oauthScopeFlags.USER_READ_PUBLIC.toString());
  assert.equal(asBits.ok, true);
  if (asBits.ok) {
    assert.equal(asBits.bits, oauthScopeFlags.USER_READ_PUBLIC);
  }

  const emailBlocked = parseScopeString('User.Read.Email');
  assert.equal(emailBlocked.ok, false);

  const emailBitsBlocked = parseScopeString(oauthScopeFlags.USER_READ_EMAIL.toString());
  assert.equal(emailBitsBlocked.ok, false);

  const bad = parseScopeString('User.Submission.Create');
  assert.equal(bad.ok, false);

  const unknown = parseScopeString('User.Read.Hack');
  assert.equal(unknown.ok, false);
});

test('scopeBitsToNames only lists grantable flags present', () => {
  const bits = oauthScopeFlags.USER_READ_PUBLIC | oauthScopeFlags.USER_SUBMISSION_CREATE;
  assert.deepEqual(scopeBitsToNames(bits), ['User.Read.Public']);
  assert.equal((bits & ~V1_GRANTABLE_MASK) !== 0n, true);
});

test('redirect URI exact match and reject dangerous schemes', () => {
  const registered = [
    'http://127.0.0.1:8765/callback',
    'tuflite://oauth/callback',
    'https://app.example.com/cb',
  ];
  assert.equal(isRedirectUriAllowed(registered, 'http://127.0.0.1:8765/callback'), true);
  assert.equal(isRedirectUriAllowed(registered, 'http://127.0.0.1:8765/callback/'), false);
  assert.equal(isRedirectUriAllowed(registered, 'https://app.example.com.evil.com/cb'), false);

  assert.throws(() => assertValidRedirectUri('javascript:alert(1)'), OAuthClientError);
  assert.throws(() => assertValidRedirectUri('http://example.com/cb'), OAuthClientError);
  assert.doesNotThrow(() => assertValidRedirectUri('http://127.0.0.1:8765/callback'));
  assert.doesNotThrow(() => assertValidRedirectUri('tuflite://oauth/callback'));
});

test('PKCE S256 verify succeeds and rejects wrong verifier / plain-like short', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  assert.equal(verifyPkce(verifier, challenge), true);
  assert.equal(verifyPkce(verifier + 'x', challenge), false);
  assert.equal(verifyPkce('short', challenge), false);
});

test('OAuth access JWT is not interchangeable with website access JWT', () => {
  const oauthJwt = mintOAuthAccessToken({
    userId: '00000000-0000-4000-8000-000000000001',
    clientId: 'abc',
    grantId: '00000000-0000-4000-8000-000000000002',
    scopeBits: oauthScopeFlags.USER_READ_PUBLIC,
  });
  const claims = verifyOAuthAccessToken(oauthJwt);
  assert.ok(claims);
  assert.equal(claims?.token_use, 'access');
  assert.equal(claims?.aud, 'tuf-api');

  // Website verifier must not accept OAuth token
  assert.equal(tokenUtils.verifyAccessToken(oauthJwt), null);

  // Fake website-shaped token must not verify as OAuth
  assert.equal(verifyOAuthAccessToken('not.a.jwt'), null);
});

test('scopesMatch is exact equality', () => {
  assert.equal(
    scopesMatch(oauthScopeFlags.USER_READ_PUBLIC, oauthScopeFlags.USER_READ_PUBLIC),
    true,
  );
  assert.equal(
    scopesMatch(
      oauthScopeFlags.USER_READ_PUBLIC,
      oauthScopeFlags.USER_READ_PUBLIC | oauthScopeFlags.USER_READ_EMAIL,
    ),
    false,
  );
});
