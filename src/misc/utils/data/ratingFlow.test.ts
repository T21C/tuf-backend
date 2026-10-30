import assert from 'node:assert/strict';
import test from 'node:test';
import {
  autoraterHideBand,
  combinedTierFromAutorater,
  evaluateRatingFlow,
  explicitRequestBand,
  parseAutoraterCombined,
  resolveCombinedTier,
  type FlowDifficulty,
  type FlowDetail,
} from './ratingFlow.js';

function ladder(): FlowDifficulty[] {
  const rows: FlowDifficulty[] = [];
  let order = 1;
  for (const letter of ['P', 'G', 'U'] as const) {
    for (let n = 1; n <= 20; n += 1) {
      rows.push({ id: order, name: `${letter}${n}`, type: 'PGU', sortOrder: order });
      order += 1;
    }
  }
  rows.push(
    { id: 200, name: 'GQ0 (G1~G4)', type: 'SPECIAL', sortOrder: 200 },
    { id: 201, name: 'GQ4 (G17~G20)', type: 'SPECIAL', sortOrder: 201 },
    { id: 202, name: 'UQ0 (U1~U4)', type: 'SPECIAL', sortOrder: 202 },
    { id: 203, name: 'Impossible', type: 'SPECIAL', sortOrder: 300 },
    { id: 204, name: 'Censored', type: 'SPECIAL', sortOrder: 301 },
    { id: 205, name: 'Unranked', type: 'SPECIAL', sortOrder: 0 },
  );
  return rows;
}

const difficulties = ladder();

function detail(id: number, rating: string): FlowDetail {
  return { id, userId: `user-${id}`, rating, isCommunityRating: false };
}

function evaluate(overrides: Partial<Parameters<typeof evaluateRatingFlow>[0]>) {
  return evaluateRatingFlow({
    diffId: 0,
    diffName: 'Unranked',
    clears: 0,
    rerateNum: '',
    isDiscordVote: false,
    combinedTier: null,
    details: [],
    autoraterUserId: 'autorater',
    tags: [],
    manuallyBlocked: false,
    difficulties,
    ...overrides,
  });
}

test('explicitRequestBand ignores text that is not a rating', () => {
  assert.equal(explicitRequestBand('cleared'), null);
  assert.equal(explicitRequestBand('P12'), 'P');
  assert.equal(explicitRequestBand('vote U1'), 'U');
  assert.equal(explicitRequestBand('GQ0'), 'G');
});

test('parseAutoraterCombined reads an AutoRater V2 rating result', () => {
  const parsed = parseAutoraterCombined({
    tufid: 17158,
    rating_result: 'U7 high (U8, U7, U6, U7)',
    avg: 'U7 high',
    rr: 'U8',
    v2: 'U7',
    v21: 'U6',
    v22: 'U7',
  });
  assert.equal(parsed?.tier, 'U7');
  assert.equal(parsed?.rule, 'U7 high');
  assert.deepEqual(parsed?.used, ['U8', 'U7', 'U6', 'U7']);
  assert.equal(parsed?.value, null);
});

test('parseAutoraterCombined reads the embed combined tier', () => {
  const parsed = parseAutoraterCombined({
    rating: {
      model_fingerprint: 'abc',
      result: {
        combined: { tier: 'G17', value: 37.3925, used: ['rr', 'v22'], rule: 'average of 2 raters' },
        rr: { tier: 'G11', range: ['G11', 'U1'] },
      },
    },
  });
  assert.equal(parsed?.tier, 'G17');
  assert.equal(parsed?.value, 37.3925);
  assert.deepEqual(parsed?.used, ['rr', 'v22']);
  assert.equal(parsed?.modelFingerprint, 'abc');
});

test('resolveCombinedTier uses the saved AutoRater display string', () => {
  assert.equal(combinedTierFromAutorater('P12 low (P12, P11, P12, P13)'), 'P12');
  assert.equal(combinedTierFromAutorater('Impossible (Impossible, Impossible, Impossible, Impossible)'), 'Impossible');
  assert.equal(combinedTierFromAutorater('not a rating'), null);
  assert.equal(resolveCombinedTier([
    { id: 2, userId: 'human', rating: 'P11', isCommunityRating: false },
    { id: 1, userId: 'autorater', rating: 'P12 mid (P11, P12, P12, P13)', isCommunityRating: false },
  ], 'autorater', null), 'P12');
});

test('flow 1 uses the V2 AVG tier from the display string', () => {
  const decision = evaluate({
    combinedTier: 'P12 mid (P11, P12, P12, P13)',
    details: [detail(1, 'P12')],
  });
  assert.equal(decision.flow, 1);
  assert.equal(decision.cardBand, 'P');
  assert.equal(decision.rankState, 'rankable');
  assert.equal(decision.settleActor, 'rater');
  assert.equal(decision.suggestedDiffName, 'P12');
});

test('flow 1 exact P match is settlable by a rater', () => {
  const decision = evaluate({
    combinedTier: 'P12',
    details: [detail(1, 'P12')],
  });
  assert.equal(decision.flow, 1);
  assert.equal(decision.cardBand, 'P');
  assert.equal(decision.rankState, 'rankable');
  assert.equal(decision.settleActor, 'rater');
  assert.equal(decision.suggestedDiffName, 'P12');
  assert.equal(decision.showRankable, true);
});

test('flow 1 P off by one waits, then a second vote between is admin settle', () => {
  const waiting = evaluate({
    combinedTier: 'P12',
    details: [detail(1, 'P11')],
  });
  assert.equal(waiting.rankState, 'waiting');
  assert.equal(waiting.settleActor, null);

  const ready = evaluate({
    combinedTier: 'P12',
    details: [detail(1, 'P11'), detail(2, 'P12')],
  });
  assert.equal(ready.rankState, 'rankable');
  assert.equal(ready.settleActor, 'admin');
  assert.equal(ready.suggestedDiffName, 'P12');

  const outside = evaluate({
    combinedTier: 'P12',
    details: [detail(1, 'P11'), detail(2, 'P10')],
  });
  assert.equal(outside.rankState, 'ratingOff');
  assert.equal(outside.showRatingOff, true);
  assert.equal(outside.showRankable, false);
});

test('P20 to G1 is one ladder step', () => {
  const decision = evaluate({
    combinedTier: 'P20',
    details: [detail(1, 'G1')],
  });
  assert.equal(decision.flow, 1);
  assert.equal(decision.rankState, 'waiting');
});

test('flow 1 G agreement settles the Q bucket', () => {
  const decision = evaluate({
    combinedTier: 'G17',
    details: [detail(1, 'G18')],
  });
  assert.equal(decision.flow, 1);
  assert.equal(decision.cardBand, 'G');
  assert.equal(decision.rankState, 'rankable');
  assert.equal(decision.settleActor, 'rater');
  assert.equal(decision.suggestedDiffName, 'GQ4 (G17~G20)');
});

test('cleared unranked G moves to flow 2', () => {
  const decision = evaluate({
    clears: 1,
    combinedTier: 'G17',
    details: [detail(1, 'G17'), detail(2, 'G18')],
  });
  assert.equal(decision.flow, 2);
  assert.equal(decision.cardBand, null);
  assert.equal(decision.rankState, 'rankable');
  assert.equal(decision.settleActor, 'admin');
});

test('UQ0 and discord votes are flow 3', () => {
  assert.equal(evaluate({ diffId: 8, diffName: 'UQ0 (U1~U4)', combinedTier: 'U2' }).flow, 3);
  assert.equal(evaluate({ isDiscordVote: true, rerateNum: 'U12', diffId: 40, diffName: 'U5' }).flow, 3);
  assert.equal(evaluate({ diffId: 40, diffName: 'G12', rerateNum: 'U8' }).flow, 3);
});

test('GQ0 and a P rerate are flow 2', () => {
  assert.equal(evaluate({ diffId: 4, diffName: 'GQ0 (G1~G4)', clears: 1 }).flow, 2);
  assert.equal(evaluate({ diffId: 12, diffName: 'P8', rerateNum: 'P10' }).flow, 2);
});

test('one manager Censored blocks auto rank and a community Censored does not', () => {
  const manager = evaluate({
    combinedTier: 'P12',
    details: [
      detail(1, 'P12'),
      { id: 2, userId: 'user-2', rating: 'Censored', isCommunityRating: false },
    ],
  });
  assert.equal(manager.cardBand, 'P');
  assert.equal(manager.autoRankDisabled, true);
  assert.equal(manager.settleActor, 'admin');
  assert.equal(manager.showRankable, false);

  const community = evaluate({
    combinedTier: 'P12',
    details: [
      detail(1, 'P12'),
      { id: 2, userId: 'user-2', rating: 'Censored', isCommunityRating: true },
    ],
  });
  assert.equal(community.autoRankDisabled, false);
  assert.equal(community.settleActor, 'rater');
});

test('an Impossible model blocks auto rank and colors the card', () => {
  const decision = evaluate({
    combinedTier: 'P12 mid (P12, Impossible, P12, P11)',
    details: [detail(1, 'P12')],
  });
  assert.equal(decision.flow, 1);
  assert.equal(decision.cardBand, 'Impossible');
  assert.equal(decision.autoRankDisabled, true);
  assert.equal(decision.rankState, 'rankable');
  assert.equal(decision.settleActor, 'admin');
  assert.equal(decision.showRankable, false);
  assert.equal(autoraterHideBand('P12 mid (P12, Impossible, P12, P11)'), 'P');
  assert.equal(autoraterHideBand('U7 high (U8, U7, U6, U7)'), 'U');
  assert.equal(autoraterHideBand(null), null);
});

test('flow 2 drops the autorater color even when a model is Impossible', () => {
  const decision = evaluate({
    diffId: 12,
    diffName: 'P8',
    rerateNum: 'P10',
    combinedTier: 'G17 high (G17, Impossible, G16, G18)',
    details: [detail(1, 'G17'), detail(2, 'G18')],
  });
  assert.equal(decision.flow, 2);
  assert.equal(decision.cardBand, null);
  assert.equal(decision.autoRankDisabled, true);
});

test('Impossible and Censored human votes disable rater settle without recoloring', () => {
  const decision = evaluate({
    combinedTier: 'P12',
    details: [detail(1, 'P12'), detail(2, 'Impossible')],
  });
  assert.equal(decision.cardBand, 'P');
  assert.equal(decision.autoRankDisabled, true);
  assert.equal(decision.settleActor, 'admin');
  assert.equal(decision.showRankable, false);
});

test('judgement and key limit tags disable auto rank', () => {
  const decision = evaluate({
    combinedTier: 'P4',
    details: [detail(1, 'P4')],
    tags: [{ name: 'Judgement Limit' }, { name: '4 Key Limit' }],
  });
  assert.equal(decision.autoRankDisabled, true);
  assert.equal(decision.indicators.judgementLimit, true);
  assert.equal(decision.indicators.keyLimit, true);
  assert.equal(decision.settleActor, 'admin');
});

test('a rater block keeps the card manual', () => {
  const decision = evaluate({
    combinedTier: 'G17',
    details: [detail(1, 'G18')],
    manuallyBlocked: true,
  });
  assert.equal(decision.rankState, 'rankable');
  assert.equal(decision.settleActor, 'admin');
  assert.equal(decision.showRankable, false);
});
