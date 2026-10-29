import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateRatingFlow,
  explicitRequestBand,
  parseAutoraterCombined,
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
