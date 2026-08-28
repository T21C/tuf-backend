import assert from 'node:assert/strict';
import test from 'node:test';
import {
  selectLevelCardDisplayTags,
  shouldDestroyCommunityAssignment,
  shouldKeepCommunityAssignment,
  voteWeightForClearer,
  wilsonLowerBound,
  wilsonScore,
} from './communityTagScoring.js';
import {
  canVoteByTopPlay,
  isTopPlayRequirementSatisfied,
  maxVotableSortOrder,
  normalizeVoteAction,
  parseAllowedBands,
  parseCommunityTagKnobFields,
  parseScoringMode,
  pguBandFromDifficultyName,
  resolveCommunityTagSettings,
  tagAllowedForDifficulty,
} from './communityTagEligibility.js';

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

test('wilsonLowerBound with no downvotes matches wilsonScore', () => {
  assert.equal(wilsonLowerBound(10, 10, 1.96), wilsonScore(10, 1.96));
});

test('wilsonLowerBound drops when downvotes are present', () => {
  const allUp = wilsonLowerBound(10, 10, 1.96);
  const mixed = wilsonLowerBound(10, 20, 1.96);
  assert.ok(mixed < allUp);
  assert.ok(mixed < 0.4);
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

test('shouldDestroyCommunityAssignment honors preserveAssignments', () => {
  assert.equal(
    shouldDestroyCommunityAssignment({
      preserveAssignments: true,
      chartCleared: true,
      bandOk: true,
      keep: false,
    }),
    false,
  );
  assert.equal(
    shouldDestroyCommunityAssignment({
      preserveAssignments: true,
      chartCleared: false,
      bandOk: false,
      keep: false,
    }),
    false,
  );
  assert.equal(
    shouldDestroyCommunityAssignment({
      preserveAssignments: false,
      chartCleared: true,
      bandOk: true,
      keep: false,
    }),
    true,
  );
  assert.equal(
    shouldDestroyCommunityAssignment({
      preserveAssignments: false,
      chartCleared: false,
      bandOk: true,
      keep: true,
    }),
    true,
  );
  assert.equal(
    shouldDestroyCommunityAssignment({
      preserveAssignments: false,
      chartCleared: true,
      bandOk: false,
      keep: true,
    }),
    true,
  );
  assert.equal(
    shouldDestroyCommunityAssignment({
      preserveAssignments: false,
      chartCleared: true,
      bandOk: true,
      keep: true,
    }),
    false,
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
  assert.deepEqual(visible.map((t) => t.id), [1, 2, 3, 4]);
});

test('card display order follows group then tag sortOrder, not score or input order', () => {
  const tags = [
    { id: 10, isCommunity: false, group: 'B', groupSortOrder: 1, sortOrder: 0, name: 'Staff B' },
    { id: 11, isCommunity: true, pinned: false, score: 0.99, group: 'A', groupSortOrder: 0, sortOrder: 5, name: 'High score late in A' },
    { id: 12, isCommunity: true, pinned: true, score: 0.1, group: 'A', groupSortOrder: 0, sortOrder: 0, name: 'Pinned early in A' },
    { id: 13, isCommunity: false, group: 'A', groupSortOrder: 0, sortOrder: 1, name: 'Staff A' },
  ];
  const visible = selectLevelCardDisplayTags(tags, 7);
  assert.deepEqual(visible.map((t) => t.id), [12, 13, 11, 10]);
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

test('pguBandFromDifficultyName maps Q and U to universal', () => {
  assert.equal(pguBandFromDifficultyName('P4'), 'P');
  assert.equal(pguBandFromDifficultyName('G15'), 'G');
  assert.equal(pguBandFromDifficultyName('U1'), 'U');
  assert.equal(pguBandFromDifficultyName('Q0'), 'U');
  assert.equal(pguBandFromDifficultyName('Grandmaster'), null);
});

test('tagAllowedForDifficulty allows all when bands are empty', () => {
  assert.equal(tagAllowedForDifficulty(null, { name: 'P1', type: 'PGU' }), true);
  assert.equal(tagAllowedForDifficulty(['U'], { name: 'P1', type: 'PGU' }), false);
  assert.equal(tagAllowedForDifficulty(['U'], { name: 'U1', type: 'PGU' }), true);
  assert.equal(tagAllowedForDifficulty(['U'], { name: 'Special', type: 'SPECIAL' }), false);
  assert.equal(tagAllowedForDifficulty(['SPEC'], { name: 'Special', type: 'SPECIAL' }), true);
  assert.equal(tagAllowedForDifficulty(['SPEC'], { name: 'Legacy', type: 'LEGACY' }), true);
  assert.equal(tagAllowedForDifficulty(['P', 'SPEC'], { name: 'Grandmaster', type: 'SPECIAL' }), true);
  assert.equal(tagAllowedForDifficulty(null, { name: 'Grandmaster', type: 'SPECIAL' }), true);
});

test('G15 top play can vote on G16 and below, not U1', () => {
  const pgu = [
    { id: 15, name: 'G15', type: 'PGU', sortOrder: 35 },
    { id: 16, name: 'G16', type: 'PGU', sortOrder: 36 },
    { id: 41, name: 'U1', type: 'PGU', sortOrder: 41 },
  ];
  const top = pgu[0];
  assert.equal(maxVotableSortOrder(top, pgu), 36);
  assert.equal(canVoteByTopPlay(pgu[1], top, pgu), true);
  assert.equal(canVoteByTopPlay({ name: 'G10', type: 'PGU', sortOrder: 30 }, top, pgu), true);
  assert.equal(canVoteByTopPlay(pgu[2], top, pgu), false);
  assert.equal(canVoteByTopPlay({ name: 'P1', type: 'PGU', sortOrder: 1 }, null, pgu), false);
  assert.equal(
    canVoteByTopPlay({ name: 'Grandmaster', type: 'SPECIAL', sortOrder: 99 }, top, pgu),
    true,
  );
  assert.equal(
    canVoteByTopPlay({ name: 'Grandmaster', type: 'SPECIAL', sortOrder: 99 }, null, pgu),
    false,
  );
});

test('a clear of this level satisfies top-play even with no cached topDiff', () => {
  const pgu = [
    { id: 15, name: 'G15', type: 'PGU', sortOrder: 35 },
    { id: 16, name: 'G16', type: 'PGU', sortOrder: 36 },
    { id: 41, name: 'U1', type: 'PGU', sortOrder: 41 },
  ];
  assert.equal(
    isTopPlayRequirementSatisfied({
      levelDiff: pgu[0],
      topDiff: null,
      pguDifficulties: pgu,
      hasClearOfThisLevel: true,
    }),
    true,
  );
  assert.equal(
    isTopPlayRequirementSatisfied({
      levelDiff: { name: 'Grandmaster', type: 'SPECIAL', sortOrder: 99 },
      topDiff: null,
      pguDifficulties: pgu,
      hasClearOfThisLevel: true,
    }),
    true,
  );
  assert.equal(
    isTopPlayRequirementSatisfied({
      levelDiff: pgu[0],
      topDiff: null,
      pguDifficulties: pgu,
      hasClearOfThisLevel: false,
    }),
    false,
  );
  assert.equal(
    isTopPlayRequirementSatisfied({
      levelDiff: pgu[1],
      topDiff: pgu[0],
      pguDifficulties: pgu,
      hasClearOfThisLevel: false,
    }),
    true,
  );
});

test('resolveCommunityTagSettings inherits tag then group then env', () => {
  const env = {
    wilsonZ: 4,
    scoreOn: 0.45,
    scoreOff: 0.35,
    cardCap: 7,
    clearerWeight: 10,
    defaultWeight: 1,
  };
  const resolved = resolveCommunityTagSettings(
    { scoringMode: 'skillset', wilsonZ: 1.5 },
    { allowedBands: ['P'], scoreOn: 0.3 },
    env,
  );
  assert.equal(resolved.scoringMode, 'skillset');
  assert.equal(resolved.wilsonZ, 1.5);
  assert.equal(resolved.scoreOn, 0.3);
  assert.equal(resolved.scoreOff, 0.35);
  assert.deepEqual(resolved.allowedBands, ['P']);
  assert.equal(resolved.requireTopPlay, false);
});

test('requireTopPlay is tag-specific and does not inherit from the group', () => {
  const env = {
    wilsonZ: 4,
    scoreOn: 0.45,
    scoreOff: 0.35,
    cardCap: 7,
    clearerWeight: 10,
    defaultWeight: 1,
  };
  assert.equal(resolveCommunityTagSettings({}, {}, env).requireTopPlay, false);
  assert.equal(
    resolveCommunityTagSettings({ requireTopPlay: true }, { requireTopPlay: false }, env).requireTopPlay,
    true,
  );
  assert.equal(
    resolveCommunityTagSettings({ requireTopPlay: false }, { requireTopPlay: true }, env).requireTopPlay,
    false,
  );
  assert.equal(
    resolveCommunityTagSettings({}, { requireTopPlay: true }, env).requireTopPlay,
    false,
  );
});

test('parseAllowedBands and scoringMode accept form values', () => {
  assert.deepEqual(parseAllowedBands('["P","U"]'), ['P', 'U']);
  assert.deepEqual(parseAllowedBands('["P","SPEC"]'), ['P', 'SPEC']);
  assert.deepEqual(parseAllowedBands('["SPECIAL"]'), ['SPEC']);
  assert.equal(parseAllowedBands(''), null);
  assert.equal(parseScoringMode('skillset'), 'skillset');
  assert.equal(parseScoringMode(''), null);
  assert.equal(normalizeVoteAction('vote'), 'upvote');
  assert.equal(normalizeVoteAction('downvote'), 'downvote');
});

test('parseCommunityTagKnobFields treats blanks as inherit', () => {
  const parsed = parseCommunityTagKnobFields(
    {
      description: '  hard clear  ',
      wilsonZ: '',
      scoreOn: '0.3',
      scoringMode: 'skillset',
      allowedBands: '[]',
      requireTopPlay: '',
    },
    { includeDescription: true },
  );
  assert.equal(parsed.description, 'hard clear');
  assert.equal(parsed.wilsonZ, null);
  assert.equal(parsed.scoreOn, 0.3);
  assert.equal(parsed.scoringMode, 'skillset');
  assert.equal(parsed.allowedBands, null);
  assert.equal(parsed.requireTopPlay, null);
});

test('parseCommunityTagKnobFields rejects invalid knobs', () => {
  assert.throws(
    () => parseCommunityTagKnobFields({ wilsonZ: '-1' }),
    /Invalid wilsonZ/,
  );
  assert.throws(
    () => parseCommunityTagKnobFields({ scoringMode: 'votes' }),
    /Invalid scoringMode/,
  );
});
