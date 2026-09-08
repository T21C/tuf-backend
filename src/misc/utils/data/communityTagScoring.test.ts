import assert from 'node:assert/strict';
import test from 'node:test';
import {
  selectLevelCardDisplayTags,
  shouldDestroyCommunityAssignment,
  shouldKeepCommunityAssignment,
  communityTagVoteWeight,
  voteWeightForClearer,
  wilsonLowerBound,
  wilsonScore,
} from './communityTagScoring.js';
import {
  canVoteByTopPlay,
  communityTagVoteHardBlockReason,
  communityTagVoteInactiveReason,
  isTopPlayRequirementSatisfied,
  maxVotableSortOrder,
  normalizeVoteAction,
  parseAllowedBands,
  parseCommunityTagKnobFields,
  parseScoringMode,
  parseQRange,
  pguBandFromDifficultyName,
  qRangeToPguFloorName,
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

const voteWeights = { clearerWeight: 10, defaultWeight: 1 };

test('communityTagVoteWeight counts Wilson votes without a chart clear', () => {
  assert.equal(
    communityTagVoteWeight(
      { scoringMode: 'wilson', isClearer: false, topPlayOk: true },
      voteWeights,
    ),
    1,
  );
  assert.equal(
    communityTagVoteWeight(
      { scoringMode: 'wilson', isClearer: true, topPlayOk: true },
      voteWeights,
    ),
    10,
  );
});

test('communityTagVoteWeight is 0 for skillset without a personal clear', () => {
  assert.equal(
    communityTagVoteWeight(
      { scoringMode: 'skillset', isClearer: false, topPlayOk: true },
      voteWeights,
    ),
    0,
  );
  assert.equal(
    communityTagVoteWeight(
      { scoringMode: 'skillset', isClearer: true, topPlayOk: true },
      voteWeights,
    ),
    10,
  );
});

test('communityTagVoteWeight is 0 when top play is not satisfied', () => {
  assert.equal(
    communityTagVoteWeight(
      { scoringMode: 'wilson', isClearer: false, topPlayOk: false },
      voteWeights,
    ),
    0,
  );
  assert.equal(
    communityTagVoteWeight(
      { scoringMode: 'wilson', isClearer: true, topPlayOk: true },
      voteWeights,
    ),
    10,
  );
});

test('communityTagVoteWeight uses default weight for effective non-clearer Wilson votes', () => {
  assert.equal(
    communityTagVoteWeight(
      { scoringMode: 'wilson', isClearer: false, topPlayOk: true },
      voteWeights,
    ),
    1,
  );
});

test('hard vote blocks stay login banned deleted band', () => {
  assert.equal(
    communityTagVoteHardBlockReason({
      hasUser: true,
      isBanned: false,
      levelDeleted: true,
      bandOk: true,
    }),
    'deleted',
  );
  assert.equal(
    communityTagVoteHardBlockReason({
      hasUser: false,
      isBanned: false,
      levelDeleted: false,
      bandOk: true,
    }),
    'login',
  );
  assert.equal(
    communityTagVoteHardBlockReason({
      hasUser: true,
      isBanned: true,
      levelDeleted: false,
      bandOk: true,
    }),
    'banned',
  );
  assert.equal(
    communityTagVoteHardBlockReason({
      hasUser: true,
      isBanned: false,
      levelDeleted: false,
      bandOk: false,
    }),
    'band',
  );
  assert.equal(
    communityTagVoteHardBlockReason({
      hasUser: true,
      isBanned: false,
      levelDeleted: false,
      bandOk: true,
    }),
    null,
  );
});

test('inactive vote reasons cover skillset and topPlay', () => {
  assert.equal(
    communityTagVoteInactiveReason({
      topPlayOk: false,
      scoringMode: 'wilson',
      isClearer: false,
    }),
    'topPlay',
  );
  assert.equal(
    communityTagVoteInactiveReason({
      topPlayOk: true,
      scoringMode: 'skillset',
      isClearer: false,
    }),
    'mustClear',
  );
  assert.equal(
    communityTagVoteInactiveReason({
      topPlayOk: true,
      scoringMode: 'wilson',
      isClearer: false,
    }),
    null,
  );
  assert.equal(
    communityTagVoteInactiveReason({
      topPlayOk: true,
      scoringMode: 'skillset',
      isClearer: true,
    }),
    null,
  );
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
      bandOk: true,
      keep: false,
    }),
    false,
  );
  assert.equal(
    shouldDestroyCommunityAssignment({
      preserveAssignments: true,
      bandOk: false,
      keep: false,
    }),
    false,
  );
  assert.equal(
    shouldDestroyCommunityAssignment({
      preserveAssignments: false,
      bandOk: true,
      keep: false,
    }),
    true,
  );
  assert.equal(
    shouldDestroyCommunityAssignment({
      preserveAssignments: false,
      bandOk: true,
      keep: true,
    }),
    false,
  );
  assert.equal(
    shouldDestroyCommunityAssignment({
      preserveAssignments: false,
      bandOk: false,
      keep: true,
    }),
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

test('parseQRange maps GQ, UQ, and Q0-4 onto PGU buckets', () => {
  assert.deepEqual(parseQRange('GQ1'), { letter: 'G', tier: 1 });
  assert.deepEqual(parseQRange('UQ1'), { letter: 'U', tier: 1 });
  assert.deepEqual(parseQRange('Q1'), { letter: 'U', tier: 1 });
  assert.equal(qRangeToPguFloorName('GQ1'), 'G5');
  assert.equal(qRangeToPguFloorName('UQ1'), 'U5');
  assert.equal(qRangeToPguFloorName('Q1'), 'U5');
  assert.equal(qRangeToPguFloorName('GQ0'), 'G1');
  assert.equal(qRangeToPguFloorName('Qq'), null);
  assert.equal(qRangeToPguFloorName('Grandmaster'), null);
});

test('Q-range top-play uses the mapped PGU floor and +1 rule', () => {
  const pgu = [
    { id: 1, name: 'G1', type: 'PGU', sortOrder: 21 },
    { id: 4, name: 'G4', type: 'PGU', sortOrder: 24 },
    { id: 5, name: 'G5', type: 'PGU', sortOrder: 25 },
    { id: 6, name: 'G6', type: 'PGU', sortOrder: 26 },
    { id: 7, name: 'G7', type: 'PGU', sortOrder: 27 },
    { id: 21, name: 'U1', type: 'PGU', sortOrder: 41 },
    { id: 25, name: 'U5', type: 'PGU', sortOrder: 45 },
    { id: 26, name: 'U6', type: 'PGU', sortOrder: 46 },
    { id: 27, name: 'U7', type: 'PGU', sortOrder: 47 },
  ];
  const gq1 = { name: 'GQ1', type: 'SPECIAL', sortOrder: 99 };
  const uq1 = { name: 'UQ1', type: 'SPECIAL', sortOrder: 99 };
  const q1 = { name: 'Q1', type: 'SPECIAL', sortOrder: 99 };
  const g1 = pgu[0];
  const g4 = pgu[1];
  const g6 = pgu[3];
  const u1 = pgu[5];
  const u6 = pgu[7];

  assert.equal(canVoteByTopPlay(gq1, g6, pgu), true);
  assert.equal(canVoteByTopPlay(gq1, g4, pgu), true);
  assert.equal(canVoteByTopPlay(gq1, g1, pgu), false);
  assert.equal(canVoteByTopPlay(uq1, u6, pgu), true);
  assert.equal(canVoteByTopPlay(uq1, g6, pgu), false);
  assert.equal(canVoteByTopPlay(q1, u6, pgu), true);
  assert.equal(canVoteByTopPlay(gq1, u1, pgu), true);
});

test('top-play is not satisfied by a personal clear without a high enough topDiff', () => {
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
    }),
    false,
  );
  assert.equal(
    isTopPlayRequirementSatisfied({
      levelDiff: { name: 'Grandmaster', type: 'SPECIAL', sortOrder: 99 },
      topDiff: null,
      pguDifficulties: pgu,
    }),
    false,
  );
  assert.equal(
    isTopPlayRequirementSatisfied({
      levelDiff: pgu[1],
      topDiff: pgu[0],
      pguDifficulties: pgu,
    }),
    true,
  );
  assert.equal(
    isTopPlayRequirementSatisfied({
      levelDiff: { name: 'GQ1', type: 'SPECIAL', sortOrder: 99 },
      topDiff: { id: 6, name: 'G6', type: 'PGU', sortOrder: 26 },
      pguDifficulties: [
        { id: 5, name: 'G5', type: 'PGU', sortOrder: 25 },
        { id: 6, name: 'G6', type: 'PGU', sortOrder: 26 },
        { id: 7, name: 'G7', type: 'PGU', sortOrder: 27 },
      ],
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

test('requireTopPlay inherits from the group unless the tag overrides', () => {
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
    resolveCommunityTagSettings({}, { requireTopPlay: true }, env).requireTopPlay,
    true,
  );
  assert.equal(
    resolveCommunityTagSettings({ requireTopPlay: true }, { requireTopPlay: false }, env).requireTopPlay,
    true,
  );
  assert.equal(
    resolveCommunityTagSettings({ requireTopPlay: false }, { requireTopPlay: true }, env).requireTopPlay,
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
