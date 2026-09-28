import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDerivedPerfects,
  calcAcc,
  calcXAcc,
  emptyJudgements,
  getEffectiveTilecount,
  isAncient5405Pattern,
  isPureXPerfect,
  isWrongJudgement,
  nonPerfectHitCount,
  tilecount,
} from './CalcAcc.js';

describe('CalcAcc xperfect weights', () => {
  it('treats minus/plus as 1.0 like perfect', () => {
    const j = emptyJudgements();
    j.perfectMinus = 10;
    j.perfect = 10;
    j.perfectPlus = 10;
    assert.equal(calcAcc(j), 1);
    assert.equal(tilecount(j), 30);
  });

  it('keeps ePerfect at 0.75', () => {
    const j = emptyJudgements();
    j.perfect = 1;
    j.ePerfect = 1;
    assert.equal(calcAcc(j), (1 + 0.75) / 2);
  });

  it('includes minus/plus in mixed X-Perfect clears (not the 7-bucket SQL formula)', () => {
    const j = emptyJudgements();
    j.earlyDouble = 1;
    j.earlySingle = 22;
    j.ePerfect = 112;
    j.perfectMinus = 422;
    j.perfect = 3893;
    j.perfectPlus = 169;
    j.lPerfect = 20;
    j.lateSingle = 6;
    const total = 1 + 22 + 112 + 422 + 3893 + 169 + 20 + 6;
    const weighted = 422 + 3893 + 169 + (112 + 20) * 0.75 + (22 + 6) * 0.4 + 1 * 0.2;
    assert.equal(total, 4645);
    assert.equal(calcAcc(j), weighted / total);
    const omittedPlusMinus = (3893 + (112 + 20) * 0.75 + (22 + 6) * 0.4 + 1 * 0.2) / (total - 422 - 169);
    assert.ok(Math.abs(omittedPlusMinus - 0.9875) < 5e-5);
    assert.ok(calcAcc(j) > omittedPlusMinus);
  });

  it('detects 5-40-5 and pure xperfect', () => {
    const ancient = emptyJudgements();
    ancient.ePerfect = 5;
    ancient.perfect = 40;
    ancient.lPerfect = 5;
    assert.equal(isAncient5405Pattern(ancient), true);

    const xp = emptyJudgements();
    xp.perfect = 100;
    assert.equal(isPureXPerfect(xp, true), true);
    assert.equal(isPureXPerfect(xp, false), false);

    const mixedPerfectBand = emptyJudgements();
    mixedPerfectBand.perfectMinus = 6;
    mixedPerfectBand.perfect = 1620;
    mixedPerfectBand.perfectPlus = 15;
    assert.equal(calcAcc(mixedPerfectBand), 1);
    assert.equal(isPureXPerfect(mixedPerfectBand, true), false);
    assert.equal(calcXAcc(mixedPerfectBand), (1620 + 0.9 * 21) / 1641);

    const allCenter = emptyJudgements();
    allCenter.perfect = 1641;
    assert.equal(calcXAcc(allCenter), 1);
    assert.equal(calcXAcc(allCenter), calcAcc(allCenter));
  });
});

describe('isWrongJudgement', () => {
  it('treats missing or non-positive achievable tilecount as not wrong', () => {
    const j = emptyJudgements();
    j.perfect = 10;
    assert.equal(isWrongJudgement(j, {tilecount: null}), false);
    assert.equal(isWrongJudgement(j, {tilecount: 0}), false);
    assert.equal(isWrongJudgement(j, {tilecount: 8, autoTileCount: 8}), false);
    assert.equal(getEffectiveTilecount(null), null);
    assert.equal(getEffectiveTilecount(8, 8), 0);
  });

  it('flags hit totals that do not match tilecount minus auto tiles', () => {
    const j = emptyJudgements();
    j.perfect = 90;
    j.perfectMinus = 5;
    j.perfectPlus = 5;
    assert.equal(isWrongJudgement(j, {tilecount: 100, autoTileCount: 0}), false);
    assert.equal(isWrongJudgement(j, {tilecount: 108, autoTileCount: 8}), false);
    j.lateSingle = 1;
    assert.equal(isWrongJudgement(j, {tilecount: 100}), true);
    assert.equal(isWrongJudgement(j, {tilecount: 108, autoTileCount: 8}), true);
  });

  it('ignores early/late doubles in the hit total', () => {
    const j = emptyJudgements();
    j.perfect = 100;
    j.earlyDouble = 12;
    j.lateDouble = 3;
    assert.equal(isWrongJudgement(j, {tilecount: 100}), false);
  });
});

describe('applyDerivedPerfects', () => {
  it('sets perfects to achievable minus non-perfects (typo mixed clear)', () => {
    const j = emptyJudgements();
    j.perfect = 4960;
    j.ePerfect = 40;
    j.lateSingle = 10;
    const r = applyDerivedPerfects({judgements: j, tilecount: 4900, autoTileCount: 0});
    assert.equal(r.applied, true);
    assert.equal(r.perfect, 4850);
    assert.equal(r.judgements.perfect, 4850);
    assert.equal(r.judgements.ePerfect, 40);
    assert.equal(r.judgements.lateSingle, 10);
    assert.equal(nonPerfectHitCount(r.judgements), 50);
  });

  it('matches the exact legacy rewrite residual of 4950 + 50 with 100 midspins', () => {
    const j = emptyJudgements();
    j.perfect = 4950;
    j.earlySingle = 20;
    j.lPerfect = 30;
    const r = applyDerivedPerfects({judgements: j, tilecount: 4900});
    assert.equal(r.applied, true);
    assert.equal(r.judgements.perfect, 4850);
  });

  it('still applies when stored perfects already equal the function', () => {
    const j = emptyJudgements();
    j.perfect = 4850;
    j.ePerfect = 50;
    const r = applyDerivedPerfects({judgements: j, tilecount: 4900});
    assert.equal(r.applied, true);
    assert.equal(r.judgements.perfect, 4850);
  });

  it('leaves pure perfects to the midspin subtract path', () => {
    const j = emptyJudgements();
    j.perfect = 5000;
    const r = applyDerivedPerfects({judgements: j, tilecount: 4900});
    assert.equal(r.applied, false);
    assert.equal(r.skippedReason, 'nonperfects_zero');
    assert.equal(r.judgements.perfect, 5000);
  });

  it('does not apply when non-perfects exceed achievable', () => {
    const j = emptyJudgements();
    j.perfect = 10;
    j.ePerfect = 5000;
    const r = applyDerivedPerfects({judgements: j, tilecount: 4900});
    assert.equal(r.applied, false);
    assert.equal(r.skippedReason, 'would_go_negative');
    assert.equal(r.judgements.perfect, 10);
  });

  it('does not rewrite the ancient 5-40-5 placeholder', () => {
    const ancient = emptyJudgements();
    ancient.ePerfect = 5;
    ancient.perfect = 40;
    ancient.lPerfect = 5;
    const r = applyDerivedPerfects({judgements: ancient, tilecount: 40});
    assert.equal(r.applied, false);
    assert.equal(r.skippedReason, 'ancient_5405');
    assert.equal(r.judgements.perfect, 40);
  });

  it('excludes doubles from the non-perfect sum', () => {
    const j = emptyJudgements();
    j.perfect = 4960;
    j.ePerfect = 50;
    j.earlyDouble = 80;
    j.lateDouble = 20;
    const r = applyDerivedPerfects({judgements: j, tilecount: 4900});
    assert.equal(r.applied, true);
    assert.equal(r.judgements.perfect, 4850);
    assert.equal(r.judgements.earlyDouble, 80);
    assert.equal(nonPerfectHitCount(j), 50);
  });

  it('subtracts auto tiles from achievable', () => {
    const j = emptyJudgements();
    j.perfect = 4960;
    j.lPerfect = 50;
    const r = applyDerivedPerfects({judgements: j, tilecount: 5000, autoTileCount: 100});
    assert.equal(r.applied, true);
    assert.equal(r.judgements.perfect, 4850);
  });

  it('skips when tilecount is missing', () => {
    const j = emptyJudgements();
    j.perfect = 100;
    j.ePerfect = 5;
    const r = applyDerivedPerfects({judgements: j, tilecount: null});
    assert.equal(r.applied, false);
    assert.equal(r.skippedReason, 'achievable_missing');
  });
});
