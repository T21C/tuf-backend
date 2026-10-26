import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ratingMatchesAnnouncementWindow,
  rerateAnnouncementThreadUrl,
} from './rerateAnnouncementThread.js';

const jump = 'https://discord.com/channels/1/2/3';

test('ratingMatchesAnnouncementWindow accepts a settle within an hour of enqueue', () => {
  const queued = new Date('2026-10-26T01:00:00.000Z');
  assert.equal(ratingMatchesAnnouncementWindow(queued, queued), true);
  assert.equal(
    ratingMatchesAnnouncementWindow(new Date(queued.getTime() + 59 * 60 * 1000), queued),
    true,
  );
  assert.equal(
    ratingMatchesAnnouncementWindow(new Date(queued.getTime() - 59 * 60 * 1000), queued),
    true,
  );
});

test('ratingMatchesAnnouncementWindow rejects missing times and older ratings', () => {
  const queued = new Date('2026-10-26T01:00:00.000Z');
  assert.equal(ratingMatchesAnnouncementWindow(null, queued), false);
  assert.equal(ratingMatchesAnnouncementWindow(queued, null), false);
  assert.equal(
    ratingMatchesAnnouncementWindow(new Date(queued.getTime() + 61 * 60 * 1000), queued),
    false,
  );
});

test('rerateAnnouncementThreadUrl prefers the request jump link when the request owns the thread', () => {
  assert.equal(
    rerateAnnouncementThreadUrl({
      ratingUrl: 'https://discord.com/channels/9/9/9',
      requestUrl: jump,
      requestStatus: 'discord_vote',
    }),
    jump,
  );
  assert.equal(
    rerateAnnouncementThreadUrl({
      ratingUrl: jump,
      requestUrl: null,
      immediateSettle: true,
    }),
    jump,
  );
});

test('rerateAnnouncementThreadUrl uses the rating jump link when the request does not own the thread', () => {
  assert.equal(
    rerateAnnouncementThreadUrl({
      ratingUrl: jump,
      requestUrl: null,
    }),
    jump,
  );
});

test('rerateAnnouncementThreadUrl skips missing or non-jump URLs', () => {
  assert.equal(rerateAnnouncementThreadUrl({ratingUrl: 'https://example.com/x'}), null);
  assert.equal(rerateAnnouncementThreadUrl({ratingUrl: null, requestUrl: null}), null);
});
