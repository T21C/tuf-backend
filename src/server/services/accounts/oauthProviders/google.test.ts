import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGoogleAuthorizeUrl, usernameFromGoogleEmail } from './google.js';
import { getOAuthProviderAdapter } from './registry.js';

void test('google authorize URL uses a query-free redirect_uri, state, and select_account', () => {
  const url = new URL(
    buildGoogleAuthorizeUrl(
      'google-client-id',
      'https://tuforums.com/callback',
      'nonce-value',
    ),
  );
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'google-client-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://tuforums.com/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.get('state'), 'nonce-value');
  assert.equal(url.searchParams.get('prompt'), 'select_account');
  assert.equal(url.searchParams.get('linking'), null);
});

void test('google username is the sanitized email local-part', () => {
  assert.equal(usernameFromGoogleEmail('Ada.Lovelace@gmail.com'), 'ada.lovelace');
});

void test('oauth provider registry includes discord and google', () => {
  assert.equal(getOAuthProviderAdapter('discord')?.id, 'discord');
  assert.equal(getOAuthProviderAdapter('google')?.id, 'google');
  assert.equal(getOAuthProviderAdapter('github'), null);
  assert.equal(getOAuthProviderAdapter(''), null);
  assert.equal(getOAuthProviderAdapter(undefined), null);
});
