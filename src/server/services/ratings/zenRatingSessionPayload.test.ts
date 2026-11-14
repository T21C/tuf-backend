import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compactZenSessionProgress,
  isUnfinishedZenPayload,
  nextRatedInZen,
  sanitizeZenSessionPayload,
  type ZenSessionPayload,
} from './zenRatingSessionPayload.js';

function samplePayload(
  overrides: Partial<ZenSessionPayload> = {}
): ZenSessionPayload {
  return {
    phase: 'stage',
    deckSize: 15,
    includeP: true,
    includeG: true,
    includeU: true,
    includeRecent: true,
    includeRerate: true,
    includeBulk: true,
    sortPreset: 'least',
    randomness: 40,
    ratingIds: [11, 22, 33],
    index: 1,
    cardOutcomes: [null, null, null],
    cardAnswers: [null, null, null],
    peeksLeft: 3,
    peeksAllowed: 3,
    peeksUsed: 0,
    cardPeeked: false,
    submitted: 0,
    skipped: 0,
    streak: 0,
    pendingRating: '',
    pendingComment: '',
    pendingPicks: {
      chartTypeId: null,
      chartTypeHighId: null,
      vfxTypeId: null,
      vfxTypeHighId: null,
      chartRating: '',
      vfxRating: '',
      miscTypeIds: [],
    },
    ...overrides,
  };
}

test('sanitizeZenSessionPayload accepts the date-added sort preset', () => {
  const parsed = sanitizeZenSessionPayload(samplePayload({sortPreset: 'added'}));
  assert.equal(parsed.sortPreset, 'added');
});

test('sanitizeZenSessionPayload defaults curation pools to included', () => {
  const raw = samplePayload();
  const parsed = sanitizeZenSessionPayload({
    ...raw,
    includeRecent: undefined,
    includeRerate: undefined,
    includeBulk: undefined,
  });
  assert.equal(parsed.includeRecent, true);
  assert.equal(parsed.includeRerate, true);
  assert.equal(parsed.includeBulk, true);

  const hidden = sanitizeZenSessionPayload({
    ...samplePayload(),
    includeRecent: false,
    includeBulk: 'false',
  });
  assert.equal(hidden.includeRecent, false);
  assert.equal(hidden.includeRerate, true);
  assert.equal(hidden.includeBulk, false);
});

test('sanitizeZenSessionPayload accepts a valid deck payload', () => {
  const parsed = sanitizeZenSessionPayload(samplePayload());
  assert.equal(parsed.phase, 'stage');
  assert.deepEqual(parsed.ratingIds, [11, 22, 33]);
  assert.equal(parsed.deckSize, 15);
});

test('sanitizeZenSessionPayload keeps curation range highs on pending picks', () => {
  const parsed = sanitizeZenSessionPayload(
    samplePayload({
      pendingPicks: {
        chartTypeId: 17,
        chartTypeHighId: 19,
        vfxTypeId: 21,
        vfxTypeHighId: 26,
        chartRating: 'C1-3',
        vfxRating: 'V1-3',
        miscTypeIds: [7],
      },
    })
  );
  assert.deepEqual(parsed.pendingPicks, {
    chartTypeId: 17,
    chartTypeHighId: 19,
    vfxTypeId: 21,
    vfxTypeHighId: 26,
    chartRating: 'C1-3',
    vfxRating: 'V1-3',
    miscTypeIds: [7],
  });
});

test('sanitizeZenSessionPayload rejects unknown phase, bad deck size, and mismatched arrays', () => {
  assert.throws(
    () => sanitizeZenSessionPayload(samplePayload({phase: 'paused' as never})),
    {status: 400}
  );
  assert.throws(
    () => sanitizeZenSessionPayload(samplePayload({deckSize: 201})),
    {status: 400}
  );
  assert.throws(
    () =>
      sanitizeZenSessionPayload(
        samplePayload({cardOutcomes: [null], cardAnswers: [null, null, null]})
      ),
    {status: 400}
  );
  assert.throws(
    () => sanitizeZenSessionPayload(samplePayload({ratingIds: []})),
    {status: 400}
  );
});

test('isUnfinishedZenPayload is true for stage or paused setup with a deck', () => {
  assert.equal(isUnfinishedZenPayload(samplePayload()), true);
  assert.equal(
    isUnfinishedZenPayload(samplePayload({phase: 'setup'})),
    true
  );
  assert.equal(
    isUnfinishedZenPayload(samplePayload({phase: 'done'})),
    false
  );
  assert.equal(
    isUnfinishedZenPayload(samplePayload({phase: 'setup', ratingIds: []})),
    false
  );
  assert.equal(isUnfinishedZenPayload(null), false);
});

test('compactZenSessionProgress drops missing ids and remaps the current index', () => {
  const {payload, changed} = compactZenSessionProgress(
    samplePayload({
      index: 1,
      pendingRating: 'G5',
      cardAnswers: [
        {rating: 'P1', comment: 'a', peeked: false, viewDurationSeconds: 1},
        {rating: 'G5', comment: 'b', peeked: true, viewDurationSeconds: 2},
        {rating: '', comment: '', peeked: false, viewDurationSeconds: 0},
      ],
      cardOutcomes: ['rated', null, null],
    }),
    new Set([11, 33])
  );
  assert.equal(changed, true);
  assert.deepEqual(payload.ratingIds, [11, 33]);
  assert.equal(payload.index, 1);
  assert.equal(payload.pendingRating, '');
  assert.equal(payload.cardOutcomes[0], 'rated');
});

test('compactZenSessionProgress keeps pending fields when the current card survives', () => {
  const {payload} = compactZenSessionProgress(
    samplePayload({
      index: 0,
      pendingRating: 'U1',
      pendingComment: 'draft',
    }),
    new Set([11, 33])
  );
  assert.deepEqual(payload.ratingIds, [11, 33]);
  assert.equal(payload.index, 0);
  assert.equal(payload.pendingRating, 'U1');
  assert.equal(payload.pendingComment, 'draft');
});

test('nextRatedInZen rejects a second Zen submit and clears the tag on a normal edit', () => {
  assert.deepEqual(nextRatedInZen(true, false), {ok: true, ratedInZen: true});
  assert.deepEqual(nextRatedInZen(true, true), {
    ok: false,
    status: 409,
    error: 'Level already rated in Zen Mode',
  });
  assert.deepEqual(nextRatedInZen(false, true), {ok: true, ratedInZen: false});
  assert.deepEqual(nextRatedInZen(false, false), {ok: true, ratedInZen: false});
});
