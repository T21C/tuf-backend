import assert from 'node:assert/strict';
import test from 'node:test';
import { matchOAuthWhitelist } from '@/server/middleware/oauthScopeGate.js';
import { oauthScopeFlags } from '@/config/oauthScopes.js';
import { validateAuthorizeQuery, OAuthAsError } from '@/server/services/oauth/OAuthTokenService.js';

test('oauth whitelist matches resource user GET only', () => {
  const hit = matchOAuthWhitelist('GET', '/oauth/resource/user');
  assert.ok(hit);
  assert.equal(hit?.required, oauthScopeFlags.USER_READ_PUBLIC);

  assert.equal(matchOAuthWhitelist('POST', '/oauth/resource/user'), null);
  assert.equal(matchOAuthWhitelist('GET', '/v2/auth/profile/me'), null);
  assert.equal(matchOAuthWhitelist('GET', '/oauth/token'), null);
});

test('validateAuthorizeQuery requires code + S256 + state', () => {
  assert.throws(
    () =>
      validateAuthorizeQuery({
        response_type: 'token',
        client_id: 'x',
        redirect_uri: 'http://127.0.0.1/cb',
        scope: 'User.Read.Public',
        state: 's',
        code_challenge: 'c',
        code_challenge_method: 'S256',
      }),
    OAuthAsError,
  );

  assert.throws(
    () =>
      validateAuthorizeQuery({
        response_type: 'code',
        client_id: 'x',
        redirect_uri: 'http://127.0.0.1/cb',
        scope: 'User.Read.Public',
        state: 's',
        code_challenge: 'c',
        code_challenge_method: 'plain',
      }),
    OAuthAsError,
  );

  const ok = validateAuthorizeQuery({
    response_type: 'code',
    client_id: 'x',
    redirect_uri: 'http://127.0.0.1/cb',
    scope: 'User.Read.Public',
    state: 'abc',
    code_challenge: 'challenge',
    code_challenge_method: 'S256',
  });
  assert.equal(ok.clientId, 'x');
  assert.equal(ok.codeChallengeMethod, 'S256');
});
