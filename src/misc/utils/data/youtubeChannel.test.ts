import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nextPrimaryChannelId,
  resolveYoutubeVideoMatch,
  shouldBePrimaryOnInsert,
  youtubeLinkConflict,
} from './youtubeChannel.js';

void test('youtubeLinkConflict distinguishes self vs other owner', () => {
  assert.equal(youtubeLinkConflict(null, 'user-a'), null);
  assert.equal(youtubeLinkConflict({userId: 'user-a'}, 'user-a'), 'already_linked_self');
  assert.equal(youtubeLinkConflict({userId: 'user-b'}, 'user-a'), 'already_linked_other');
});

void test('first linked channel is primary', () => {
  assert.equal(shouldBePrimaryOnInsert(0), true);
  assert.equal(shouldBePrimaryOnInsert(1), false);
  assert.equal(shouldBePrimaryOnInsert(4), false);
});

void test('unlinking primary promotes the oldest remaining channel', () => {
  const older = new Date('2026-01-01T00:00:00.000Z');
  const newer = new Date('2026-02-01T00:00:00.000Z');
  assert.equal(
    nextPrimaryChannelId(
      {channelId: 'UC-primary', isPrimary: true},
      [
        {channelId: 'UC-newer', createdAt: newer},
        {channelId: 'UC-older', createdAt: older},
      ],
    ),
    'UC-older',
  );
  assert.equal(
    nextPrimaryChannelId({channelId: 'UC-side', isPrimary: false}, [
      {channelId: 'UC-other', createdAt: older},
    ]),
    null,
  );
  assert.equal(
    nextPrimaryChannelId({channelId: 'UC-only', isPrimary: true}, []),
    null,
  );
});

void test('resolveYoutubeVideoMatch prefers submitter green over passer yellow', () => {
  const video = 'UC-video';
  assert.equal(
    resolveYoutubeVideoMatch({
      videoChannelId: video,
      submitterChannelIds: [video],
      assignedPlayerChannelIds: [video],
    }),
    'submitter',
  );
  assert.equal(
    resolveYoutubeVideoMatch({
      videoChannelId: video,
      submitterChannelIds: ['UC-other'],
      assignedPlayerChannelIds: [video],
    }),
    'player',
  );
  assert.equal(
    resolveYoutubeVideoMatch({
      videoChannelId: video,
      submitterChannelIds: ['UC-other'],
      assignedPlayerChannelIds: ['UC-passer'],
    }),
    null,
  );
  assert.equal(
    resolveYoutubeVideoMatch({
      videoChannelId: '',
      submitterChannelIds: [video],
      assignedPlayerChannelIds: [video],
    }),
    null,
  );
});
