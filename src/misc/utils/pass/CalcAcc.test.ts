import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {calcAcc, emptyJudgements, isAncient5405Pattern, isPureXPerfect, tilecount} from './CalcAcc.js';

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
  });
});
