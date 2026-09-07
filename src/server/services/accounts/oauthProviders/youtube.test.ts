import assert from 'node:assert/strict';
import test from 'node:test';
import {buildYouTubeAuthorizeUrl, parseYoutubeMineChannelList, YOUTUBE_OAUTH_SCOPE} from './youtube.js';
import {getOAuthProviderAdapter} from './registry.js';
import {
  isOAuthLinkOnlyBlocked,
  OAuthYoutubeChannelRequiredError,
} from './types.js';

void test('youtube authorize URL uses youtube.readonly, consent prompt, and query-free redirect', () => {
  const url = new URL(
    buildYouTubeAuthorizeUrl(
      'google-client-id',
      'https://tuforums.com/callback',
      'nonce-value',
    ),
  );
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'google-client-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://tuforums.com/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), YOUTUBE_OAUTH_SCOPE);
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/youtube.readonly');
  assert.equal(url.searchParams.get('state'), 'nonce-value');
  assert.equal(url.searchParams.get('prompt'), 'select_account consent');
  assert.equal(url.searchParams.get('linking'), null);
});

void test('oauth registry exposes youtube as linkOnly and blocks login/reauth', () => {
  const youtube = getOAuthProviderAdapter('youtube');
  assert.equal(youtube?.id, 'youtube');
  assert.equal(youtube?.linkOnly, true);
  assert.equal(isOAuthLinkOnlyBlocked(youtube, 'login'), true);
  assert.equal(isOAuthLinkOnlyBlocked(youtube, 'reauth'), true);
  assert.equal(isOAuthLinkOnlyBlocked(youtube, 'linking'), false);

  const google = getOAuthProviderAdapter('google');
  assert.equal(isOAuthLinkOnlyBlocked(google, 'login'), false);
  assert.equal(isOAuthLinkOnlyBlocked(google, 'reauth'), false);
});

void test('parseYoutubeMineChannelList reads id, title, and handle', () => {
  const channel = parseYoutubeMineChannelList({
    items: [
      {
        id: 'UCabcdef',
        snippet: {title: 'Example Channel', customUrl: '@example'},
      },
    ],
  });
  assert.deepEqual(channel, {
    id: 'UCabcdef',
    title: 'Example Channel',
    handle: 'example',
  });
});

void test('parseYoutubeMineChannelList rejects empty items', () => {
  assert.throws(
    () => parseYoutubeMineChannelList({items: []}),
    OAuthYoutubeChannelRequiredError,
  );
});
