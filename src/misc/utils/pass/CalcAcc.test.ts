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
