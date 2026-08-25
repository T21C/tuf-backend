import assert from 'node:assert/strict';
import test from 'node:test';
import {
  selectLevelCardDisplayTags,
  shouldKeepCommunityAssignment,
  voteWeightForClearer,
  wilsonScore,
} from './communityTagScoring.js';

const knobs = { wilsonZ: 1.96, scoreOn: 0.45, scoreOff: 0.35 };

test('wilsonScore is 0 with no evidence', () => {
  assert.equal(wilsonScore(0, 1.96), 0);
});

test('wilsonScore grows with weighted apply-count', () => {
  const oneNonClearer = wilsonScore(1, 1.96);
  const oneClearer = wilsonScore(10, 1.96);
  assert.ok(oneNonClearer > 0.2 && oneNonClearer < 0.22);
  assert.ok(oneClearer > 0.72 && oneClearer < 0.73);
  assert.ok(oneClearer > oneNonClearer);
});

test('clearer weight is 10x default', () => {
  const weights = { clearerWeight: 10, defaultWeight: 1 };
  assert.equal(voteWeightForClearer(true, weights), 10);
  assert.equal(voteWeightForClearer(false, weights), 1);
});

test('hysteresis keeps an assigned tag between on and off', () => {
  const mid = 0.4;
  assert.equal(
    shouldKeepCommunityAssignment({ assigned: false, pinned: false, score: mid, knobs }),
    false,
  );
  assert.equal(
    shouldKeepCommunityAssignment({ assigned: true, pinned: false, score: mid, knobs }),
    true,
  );
  assert.equal(
    shouldKeepCommunityAssignment({ assigned: true, pinned: false, score: 0.3, knobs }),
    false,
  );
  assert.equal(
    shouldKeepCommunityAssignment({ assigned: false, pinned: false, score: 0.5, knobs }),
    true,
  );
});

test('pinned assignments are kept below the off threshold', () => {
  assert.equal(
    shouldKeepCommunityAssignment({ assigned: true, pinned: true, score: 0, knobs }),
    true,
  );
});

test('card cap keeps pinned community tags and top unpinned by score', () => {
  const tags = [
    { id: 1, isCommunity: false, sortOrder: 1 },
    { id: 2, isCommunity: true, pinned: true, score: 0.2, sortOrder: 2 },
    { id: 3, isCommunity: true, pinned: false, score: 0.9, sortOrder: 3 },
    { id: 4, isCommunity: true, pinned: false, score: 0.8, sortOrder: 4 },
    { id: 5, isCommunity: true, pinned: false, score: 0.7, sortOrder: 5 },
  ];
  const visible = selectLevelCardDisplayTags(tags, 2);
  assert.deepEqual(visible.map((t) => t.id), [1, 3, 4, 2]);
});

test('card cap 0 keeps pinned community and drops unpinned community', () => {
  const tags = [
    { id: 1, isCommunity: false, sortOrder: 1 },
    { id: 2, isCommunity: true, pinned: true, score: 0.1, sortOrder: 2 },
    { id: 3, isCommunity: true, pinned: false, score: 0.9, sortOrder: 3 },
  ];
  const visible = selectLevelCardDisplayTags(tags, 0);
  assert.deepEqual(visible.map((t) => t.id), [1, 2]);
});

test('unpinning below off drops; pinning keeps regardless of score', () => {
  assert.equal(
    shouldKeepCommunityAssignment({ assigned: true, pinned: false, score: 0.34, knobs }),
    false,
  );
  assert.equal(
    shouldKeepCommunityAssignment({ assigned: true, pinned: true, score: 0.34, knobs }),
    true,
  );
});
