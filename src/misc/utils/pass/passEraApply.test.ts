import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {ADOFAI_VERSION} from './adofaiVersion.js';
import {emptyJudgements} from './CalcAcc.js';
import {hasPassMetaFlag, passMetaFlags} from './passMetaFlags.js';
import {preparePassJudgementsForPersist} from './passEraApply.js';

describe('preparePassJudgementsForPersist derived perfects', () => {
  it('overwrites typed perfects and skips the midspin subtract on mixed legacy clears', () => {
    const j = emptyJudgements();
    j.perfect = 4960;
    j.ePerfect = 50;
    const prepared = preparePassJudgementsForPersist({
      judgements: j,
      adofaiVersion: ADOFAI_VERSION.PRE_3_4_0,
      isXPerfectMode: false,
      midspinCount: 100,
      tilecount: 4900,
      autoTileCount: 0,
    });
    assert.equal(prepared.derived.applied, true);
    assert.equal(prepared.judgements.perfect, 4850);
    assert.equal(prepared.judgements.ePerfect, 50);
    assert.equal(prepared.decrement.applied, false);
    assert.equal(prepared.decrement.skippedReason, 'already_applied');
    assert.equal(
      hasPassMetaFlag(prepared.passMetaFlags, passMetaFlags.MIDSPIN_PERFECTS_REMOVED),
      true,
    );
  });

  it('still subtracts midspins from pure-perfect legacy clears', () => {
    const j = emptyJudgements();
    j.perfect = 5000;
    const prepared = preparePassJudgementsForPersist({
      judgements: j,
      adofaiVersion: ADOFAI_VERSION.PRE_3_4_0,
      isXPerfectMode: false,
      midspinCount: 100,
      tilecount: 4900,
    });
    assert.equal(prepared.derived.applied, false);
    assert.equal(prepared.decrement.applied, true);
    assert.equal(prepared.judgements.perfect, 4900);
  });

  it('derives perfects on latest-era mixed clears without setting the midspin bit', () => {
    const j = emptyJudgements();
    j.perfect = 4960;
    j.perfectMinus = 20;
    j.perfectPlus = 30;
    const prepared = preparePassJudgementsForPersist({
      judgements: j,
      adofaiVersion: ADOFAI_VERSION.V3_4_0,
      isXPerfectMode: true,
      midspinCount: 100,
      tilecount: 4900,
    });
    assert.equal(prepared.derived.applied, true);
    assert.equal(prepared.judgements.perfect, 4850);
    assert.equal(prepared.judgements.perfectMinus, 20);
    assert.equal(prepared.judgements.perfectPlus, 30);
    assert.equal(prepared.decrement.skippedReason, 'latest_era');
    assert.equal(
      hasPassMetaFlag(prepared.passMetaFlags, passMetaFlags.MIDSPIN_PERFECTS_REMOVED),
      false,
    );
  });
});
