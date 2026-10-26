import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseYoutubeUploadItems,
  youtubeUploadTitleMatches,
  youtubeUploadsPlaylistId,
  youtubeWatchUrl,
} from './youtubeUploads.js';

void test('youtubeUploadsPlaylistId swaps the UC prefix for UU', () => {
  assert.equal(youtubeUploadsPlaylistId('UCabcdefghij1234'), 'UUabcdefghij1234');
  assert.equal(youtubeUploadsPlaylistId('  UCabcdefghij1234  '), 'UUabcdefghij1234');
  assert.equal(youtubeUploadsPlaylistId('not-a-channel'), null);
  assert.equal(youtubeUploadsPlaylistId('UC'), null);
});

void test('parseYoutubeUploadItems keeps public and unlisted and drops private', () => {
  const videos = parseYoutubeUploadItems([
    {
      snippet: {
        title: 'Public clear',
        publishedAt: '2026-01-01T00:00:00Z',
        thumbnails: {medium: {url: 'https://i.ytimg.com/medium.jpg'}},
        resourceId: {videoId: 'pub123'},
      },
      status: {privacyStatus: 'public'},
    },
    {
      snippet: {
        title: 'Unlisted clear',
        resourceId: {videoId: 'unl123'},
      },
      status: {privacyStatus: 'unlisted'},
    },
    {
      snippet: {
        title: 'Secret',
        resourceId: {videoId: 'priv123'},
      },
      status: {privacyStatus: 'private'},
    },
    {
      snippet: {title: 'Missing id'},
      status: {privacyStatus: 'public'},
    },
    {
      snippet: {title: 'Deleted video', resourceId: {videoId: 'gone'}},
      status: {privacyStatus: 'public'},
    },
  ]);

  assert.deepEqual(
    videos.map((video) => video.videoId),
    ['pub123', 'unl123'],
  );
  assert.equal(videos[0]?.url, youtubeWatchUrl('pub123'));
  assert.equal(videos[0]?.thumbnailUrl, 'https://i.ytimg.com/medium.jpg');
  assert.equal(videos[0]?.privacyStatus, 'public');
  assert.equal(videos[1]?.privacyStatus, 'unlisted');
  assert.equal(videos[1]?.publishedAt, null);
});

void test('youtubeUploadTitleMatches is a case-insensitive contains check', () => {
  assert.equal(youtubeUploadTitleMatches('My Clear Video', ''), true);
  assert.equal(youtubeUploadTitleMatches('My Clear Video', '  clear '), true);
  assert.equal(youtubeUploadTitleMatches('My Clear Video', 'other'), false);
});
