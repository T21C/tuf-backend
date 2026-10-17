import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTIST_VERIFICATION_SYNC_ACTION,
  decideArtistVerificationSync,
  feedMatchNames,
  isEvidenceImageUrl,
  mapSevenBgStatus,
  matchArtistIds,
  parseArtistFeedRow,
  pickSevenBgStatus,
  rememberArtistKeys,
  type ArtistSyncIndex,
} from './artistVerificationSyncDecision.js';

void test('status_new 0 stays pending and is not replaced by status', () => {
  assert.equal(pickSevenBgStatus(0, 1), 0);
  assert.equal(mapSevenBgStatus(0), 'pending');
  assert.equal(mapSevenBgStatus('0'), 'pending');
});

void test('blank status_new falls back to status', () => {
  assert.equal(pickSevenBgStatus('', 4), 4);
  assert.equal(pickSevenBgStatus(null, 3), 3);
  assert.equal(pickSevenBgStatus(undefined, '2'), 2);
  assert.equal(mapSevenBgStatus(1), 'allowed');
  assert.equal(mapSevenBgStatus(2), 'mostly_declined');
  assert.equal(mapSevenBgStatus(3), 'declined');
  assert.equal(mapSevenBgStatus(4), 'mostly_allowed');
});

void test('unknown statuses are not source-aligned', () => {
  assert.equal(mapSevenBgStatus(5), null);
  assert.equal(mapSevenBgStatus(-1), null);
  assert.equal(mapSevenBgStatus(1.5), null);
  assert.equal(mapSevenBgStatus(''), null);
  assert.equal(mapSevenBgStatus('allowed'), null);
});

void test('ysmod_only is never written and blocks updates', () => {
  assert.equal(
    decideArtistVerificationSync({
      incoming: 'ysmod_only',
      matches: [],
    }).kind,
    ARTIST_VERIFICATION_SYNC_ACTION.SKIP_UNALIGNED,
  );
  const protectedDecision = decideArtistVerificationSync({
    incoming: 'allowed',
    matches: [{id: 7, verificationState: 'ysmod_only'}],
  });
  assert.deepEqual(protectedDecision, {
    kind: ARTIST_VERIFICATION_SYNC_ACTION.SKIP_PROTECTED,
    artistId: 7,
  });
});

void test('unaligned incoming does not create or update', () => {
  assert.equal(
    decideArtistVerificationSync({incoming: null, matches: []}).kind,
    ARTIST_VERIFICATION_SYNC_ACTION.SKIP_UNALIGNED,
  );
  assert.equal(
    decideArtistVerificationSync({
      incoming: 'unverified',
      matches: [{id: 1, verificationState: 'pending'}],
    }).kind,
    ARTIST_VERIFICATION_SYNC_ACTION.SKIP_UNALIGNED,
  );
});

void test('a single non-protected match updates only when the state differs', () => {
  assert.deepEqual(
    decideArtistVerificationSync({
      incoming: 'mostly_allowed',
      matches: [{id: 3, verificationState: 'pending'}],
    }),
    {
      kind: ARTIST_VERIFICATION_SYNC_ACTION.UPDATE,
      artistId: 3,
      verificationState: 'mostly_allowed',
    },
  );
  assert.deepEqual(
    decideArtistVerificationSync({
      incoming: 'allowed',
      matches: [{id: 3, verificationState: 'allowed'}],
    }),
    {kind: ARTIST_VERIFICATION_SYNC_ACTION.NOOP, artistId: 3},
  );
});

void test('no match creates and several matches are skipped', () => {
  assert.deepEqual(
    decideArtistVerificationSync({incoming: 'declined', matches: []}),
    {kind: ARTIST_VERIFICATION_SYNC_ACTION.CREATE, verificationState: 'declined'},
  );
  assert.equal(
    decideArtistVerificationSync({
      incoming: 'allowed',
      matches: [
        {id: 1, verificationState: 'pending'},
        {id: 2, verificationState: 'ysmod_only'},
      ],
    }).kind,
    ARTIST_VERIFICATION_SYNC_ACTION.SKIP_AMBIGUOUS,
  );
});

void test('name and alias keys match case-insensitively and collapse duplicates', () => {
  const index: ArtistSyncIndex = new Map();
  rememberArtistKeys(index, 4, feedMatchNames(' Camellia ', ['camellia', 'Camellia']));
  rememberArtistKeys(index, 9, ['Other']);
  assert.deepEqual(matchArtistIds(index, ['camellia']), [4]);
  assert.deepEqual(matchArtistIds(index, ['Camellia', 'missing']), [4]);
  assert.deepEqual(feedMatchNames('A', ['a', ' B ', 'b']), ['A', 'B']);
});

void test('parse keeps status_new 0, links, and evidence', () => {
  const row = parseArtistFeedRow({
    name: '  Artist  ',
    aliases: ['Alias', 'artist', ''],
    status: 1,
    status_new: 0,
    link_1: ' https://example.com/a ',
    link_2: null,
    evidenceArray: ['https://cdn.example/evidence/shot.png', 'https://cdn.example/evidence/shot.png'],
  });
  assert.ok(row);
  assert.equal(row.name, 'Artist');
  assert.deepEqual(row.aliases, ['Alias']);
  assert.equal(row.verificationState, 'pending');
  assert.deepEqual(row.links, ['https://example.com/a']);
  assert.deepEqual(row.evidenceUrls, ['https://cdn.example/evidence/shot.png']);
  assert.equal(isEvidenceImageUrl(row.evidenceUrls[0]), true);
  assert.equal(parseArtistFeedRow({name: '   ', status_new: 1}), null);
});
