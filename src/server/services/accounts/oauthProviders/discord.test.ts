import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDiscordAuthorizeUrl } from './discord.js';
import { getOAuthProviderAdapter } from './registry.js';

void test('discord authorize URL uses a query-free redirect_uri and includes state', () => {
  const url = new URL(
    buildDiscordAuthorizeUrl(
      'client-id',
      'https://tuforums.com/callback',
      'nonce-value',
    ),
  );
  assert.equal(url.origin + url.pathname, 'https://discord.com/api/oauth2/authorize');
  assert.equal(url.searchParams.get('client_id'), 'client-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://tuforums.com/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'identify email');
  assert.equal(url.searchParams.get('state'), 'nonce-value');
  assert.equal(url.searchParams.get('linking'), null);
  assert.equal(url.searchParams.has('reauth'), false);
});

void test('oauth provider registry returns discord and google and rejects unknown ids', () => {
  assert.equal(getOAuthProviderAdapter('discord')?.id, 'discord');
  assert.equal(getOAuthProviderAdapter('google')?.id, 'google');
  assert.equal(getOAuthProviderAdapter(''), null);
  assert.equal(getOAuthProviderAdapter(undefined), null);
});
