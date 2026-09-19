import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {ADOFAI_VERSION} from './adofaiVersion.js';
import {emptyJudgements} from './CalcAcc.js';
import {hasPassMetaFlag, passMetaFlags} from './passMetaFlags.js';
import {
  applyMidspinPerfectDecrement,
  applyPerfectsDelta,
  classifyMidspinRewrite,
  exactHitTotalsForMidspinDifference,
  midspinCountOrZero,
  perfectsDeltaFromMidspinChange,
  shouldApplyMidspinPerfectsDifference,
  willApplyMidspinDecrement,
} from './midspinPerfectDecrement.js';

describe('applyMidspinPerfectDecrement', () => {
  it('subtracts midspins from perfect and sets the bit', () => {
    const j = emptyJudgements();
    j.perfect = 1000;
    const r = applyMidspinPerfectDecrement({
      judgements: j,
      adofaiVersion: ADOFAI_VERSION.PRE_3_4_0,
      midspinCount: 70,
    });
    assert.equal(r.applied, true);
    assert.equal(r.judgements.perfect, 930);
    assert.equal(hasPassMetaFlag(r.passMetaFlags, passMetaFlags.MIDSPIN_PERFECTS_REMOVED), true);
  });

  it('is idempotent when the bit is set', () => {
    const j = emptyJudgements();
    j.perfect = 930;
    const r = applyMidspinPerfectDecrement({
      judgements: j,
      adofaiVersion: ADOFAI_VERSION.PRE_3_4_0,
      passMetaFlags: passMetaFlags.MIDSPIN_PERFECTS_REMOVED,
      midspinCount: 70,
    });
    assert.equal(r.applied, false);
    assert.equal(r.skippedReason, 'already_applied');
    assert.equal(r.judgements.perfect, 930);
  });

  it('does not subtract Alpha-era clears', () => {
    const j = emptyJudgements();
    j.perfect = 930;
    const r = applyMidspinPerfectDecrement({
      judgements: j,
      adofaiVersion: ADOFAI_VERSION.V3_4_0,
      midspinCount: 70,
    });
    assert.equal(r.applied, false);
    assert.equal(r.skippedReason, 'latest_era');
    assert.equal(r.judgements.perfect, 930);
    assert.equal(willApplyMidspinDecrement({
      adofaiVersion: ADOFAI_VERSION.V3_4_0,
      midspinCount: 70,
    }), false);
  });

  it('refuses when perfect is below midspin', () => {
    const j = emptyJudgements();
    j.perfect = 10;
    const r = applyMidspinPerfectDecrement({
      judgements: j,
      adofaiVersion: ADOFAI_VERSION.V2,
      midspinCount: 70,
    });
    assert.equal(r.applied, false);
    assert.equal(r.skippedReason, 'perfect_lt_midspin');
    assert.equal(hasPassMetaFlag(r.passMetaFlags, passMetaFlags.MIDSPIN_PERFECTS_REMOVED), false);
  });
});

describe('classifyMidspinRewrite', () => {
  function baseJudgements(hits: {perfect?: number; ePerfect?: number; lPerfect?: number} = {}) {
    const j = emptyJudgements();
    j.perfect = hits.perfect ?? 100;
    j.ePerfect = hits.ePerfect ?? 0;
    j.lPerfect = hits.lPerfect ?? 0;
    return j;
  }

  it('silently skips already flagged and latest era', () => {
    const j = baseJudgements();
    assert.equal(
      classifyMidspinRewrite({
        adofaiVersion: ADOFAI_VERSION.PRE_3_4_0,
        passMetaFlags: passMetaFlags.MIDSPIN_PERFECTS_REMOVED,
        hasCdnDownload: true,
        midspinCount: 10,
        tilecount: 90,
        judgements: j,
      }).action,
      'skip_silent',
    );
    assert.deepEqual(
      classifyMidspinRewrite({
        adofaiVersion: ADOFAI_VERSION.V3_4_0,
        hasCdnDownload: true,
        midspinCount: 10,
        tilecount: 90,
        judgements: j,
      }),
      {action: 'skip_silent', reason: 'latest_era'},
    );
  });

  it('writes csv skips for download, null midspin, 5-40-5, and inexact hits', () => {
    const j = baseJudgements({perfect: 100});
    assert.deepEqual(
      classifyMidspinRewrite({
        adofaiVersion: ADOFAI_VERSION.V2,
        hasCdnDownload: false,
        midspinCount: 10,
        tilecount: 90,
        judgements: j,
      }),
      {action: 'skip_csv', reason: 'no_download'},
    );
    assert.deepEqual(
      classifyMidspinRewrite({
        adofaiVersion: ADOFAI_VERSION.V2,
        hasCdnDownload: true,
        midspinCount: null,
        tilecount: 90,
        judgements: j,
      }),
      {action: 'skip_csv', reason: 'midspin_null'},
    );
    const ancient = emptyJudgements();
    ancient.ePerfect = 5;
    ancient.perfect = 40;
    ancient.lPerfect = 5;
    assert.deepEqual(
      classifyMidspinRewrite({
        adofaiVersion: ADOFAI_VERSION.PRE_3_4_0,
        hasCdnDownload: true,
        midspinCount: 10,
        tilecount: 40,
        judgements: ancient,
      }),
      {action: 'skip_csv', reason: 'ancient_5405'},
    );
    assert.deepEqual(
      classifyMidspinRewrite({
        adofaiVersion: ADOFAI_VERSION.PRE_3_4_0,
        hasCdnDownload: true,
        midspinCount: 10,
        tilecount: 90,
        judgements: baseJudgements({perfect: 95}),
      }),
      {action: 'skip_csv', reason: 'inexact'},
    );
  });

  it('flags only when midspin is 0 or hits already match tilecount', () => {
    assert.equal(
      classifyMidspinRewrite({
        adofaiVersion: ADOFAI_VERSION.PRE_3_4_0,
        hasCdnDownload: true,
        midspinCount: 0,
        tilecount: 100,
        judgements: baseJudgements({perfect: 80, ePerfect: 10, lPerfect: 5}),
      }).action,
      'flag_only',
    );
    assert.equal(
      classifyMidspinRewrite({
        adofaiVersion: ADOFAI_VERSION.V2,
        hasCdnDownload: true,
        midspinCount: 20,
        tilecount: 100,
        judgements: baseJudgements({perfect: 100}),
      }).action,
      'flag_only',
    );
  });

  it('subtracts when hits equal tilecount plus midspin and perfect is high enough', () => {
    assert.equal(
      classifyMidspinRewrite({
        adofaiVersion: ADOFAI_VERSION.PRE_3_4_0,
        hasCdnDownload: true,
        midspinCount: 20,
        tilecount: 100,
        judgements: baseJudgements({perfect: 120}),
      }).action,
      'subtract',
    );
    assert.deepEqual(
      classifyMidspinRewrite({
        adofaiVersion: ADOFAI_VERSION.PRE_3_4_0,
        hasCdnDownload: true,
        midspinCount: 20,
        tilecount: 100,
        judgements: baseJudgements({perfect: 10, ePerfect: 110}),
      }),
      {action: 'skip_csv', reason: 'inexact'},
    );
  });
});

describe('perfectsDeltaFromMidspinChange', () => {
  it('treats null as 0 and subtracts Perfects when midspins increase', () => {
    assert.equal(midspinCountOrZero(null), 0);
    assert.equal(perfectsDeltaFromMidspinChange(10, 15), -5);
    assert.equal(perfectsDeltaFromMidspinChange(null, 15), -15);
    assert.equal(perfectsDeltaFromMidspinChange(15, null), 15);
    assert.equal(perfectsDeltaFromMidspinChange(7, 7), 0);
  });

  it('applies the delta and refuses a negative Perfect count', () => {
    assert.deepEqual(applyPerfectsDelta(100, -5), {
      perfect: 95,
      applied: true,
      skippedReason: null,
    });
    assert.deepEqual(applyPerfectsDelta(100, 5), {
      perfect: 105,
      applied: true,
      skippedReason: null,
    });
    assert.deepEqual(applyPerfectsDelta(3, -5), {
      perfect: 3,
      applied: false,
      skippedReason: 'would_go_negative',
    });
    assert.deepEqual(applyPerfectsDelta(100, 0), {
      perfect: 100,
      applied: false,
      skippedReason: 'no_change',
    });
  });
});

describe('shouldApplyMidspinPerfectsDifference', () => {
  function hits(perfect: number, extra: {ePerfect?: number; lPerfect?: number} = {}) {
    const j = emptyJudgements();
    j.perfect = perfect;
    j.ePerfect = extra.ePerfect ?? 0;
    j.lPerfect = extra.lPerfect ?? 0;
    return j;
  }

  const base = {
    tilecount: 100,
    autoTileCount: 0,
    adofaiVersion: ADOFAI_VERSION.PRE_3_4_0,
  };

  it('first-time set only moves uncorrected extras (tilecount + new midspin)', () => {
    const delta = perfectsDeltaFromMidspinChange(0, 15);
    assert.equal(delta, -15);
    assert.deepEqual(
      [...exactHitTotalsForMidspinDifference(100, 0, 0, 15)].sort((a, b) => a - b),
      [115],
    );
    assert.equal(
      shouldApplyMidspinPerfectsDifference({
        ...base,
        judgements: hits(115),
        oldMidspinCount: 0,
        newMidspinCount: 15,
        perfectDelta: delta,
      }).apply,
      true,
    );
    assert.equal(
      shouldApplyMidspinPerfectsDifference({
        ...base,
        judgements: hits(100),
        oldMidspinCount: 0,
        newMidspinCount: 15,
        perfectDelta: delta,
      }).reason,
      'inexact',
    );
  });

  it('correction only moves exact tilecount and tilecount+old midspin', () => {
    const delta = perfectsDeltaFromMidspinChange(10, 15);
    assert.equal(delta, -5);
    assert.deepEqual(
      [...exactHitTotalsForMidspinDifference(100, 0, 10, 15)].sort((a, b) => a - b),
      [100, 110],
    );
    assert.equal(
      shouldApplyMidspinPerfectsDifference({
        ...base,
        judgements: hits(100),
        oldMidspinCount: 10,
        newMidspinCount: 15,
        perfectDelta: delta,
      }).apply,
      true,
    );
    assert.equal(
      shouldApplyMidspinPerfectsDifference({
        ...base,
        judgements: hits(90, {ePerfect: 10, lPerfect: 10}),
        oldMidspinCount: 10,
        newMidspinCount: 15,
        perfectDelta: delta,
      }).apply,
      true,
    );
    assert.equal(
      shouldApplyMidspinPerfectsDifference({
        ...base,
        judgements: hits(107),
        oldMidspinCount: 10,
        newMidspinCount: 15,
        perfectDelta: delta,
      }).reason,
      'inexact',
    );
    assert.equal(
      shouldApplyMidspinPerfectsDifference({
        ...base,
        judgements: hits(115),
        oldMidspinCount: 10,
        newMidspinCount: 15,
        perfectDelta: delta,
      }).reason,
      'inexact',
    );
  });

  it('skips latest-era, ancient 5-40-5, and missing tilecount', () => {
    const delta = perfectsDeltaFromMidspinChange(10, 15);
    assert.equal(
      shouldApplyMidspinPerfectsDifference({
        ...base,
        adofaiVersion: ADOFAI_VERSION.V3_4_0,
        judgements: hits(100),
        oldMidspinCount: 10,
        newMidspinCount: 15,
        perfectDelta: delta,
      }).reason,
      'latest_era',
    );
    const ancient = emptyJudgements();
    ancient.ePerfect = 5;
    ancient.perfect = 40;
    ancient.lPerfect = 5;
    assert.equal(
      shouldApplyMidspinPerfectsDifference({
        tilecount: 50,
        autoTileCount: 0,
        adofaiVersion: ADOFAI_VERSION.PRE_3_4_0,
        judgements: ancient,
        oldMidspinCount: 10,
        newMidspinCount: 15,
        perfectDelta: delta,
      }).reason,
      'ancient_5405',
    );
    assert.equal(
      shouldApplyMidspinPerfectsDifference({
        ...base,
        tilecount: null,
        judgements: hits(100),
        oldMidspinCount: 10,
        newMidspinCount: 15,
        perfectDelta: delta,
      }).reason,
      'tilecount_missing',
    );
  });

  it('subtracts auto tiles from the expected total', () => {
    const delta = perfectsDeltaFromMidspinChange(10, 15);
    assert.equal(
      shouldApplyMidspinPerfectsDifference({
        tilecount: 100,
        autoTileCount: 8,
        adofaiVersion: ADOFAI_VERSION.V2,
        judgements: hits(92),
        oldMidspinCount: 10,
        newMidspinCount: 15,
        perfectDelta: delta,
      }).apply,
      true,
    );
    assert.equal(
      shouldApplyMidspinPerfectsDifference({
        tilecount: 100,
        autoTileCount: 8,
        adofaiVersion: ADOFAI_VERSION.V2,
        judgements: hits(100),
        oldMidspinCount: 10,
        newMidspinCount: 15,
        perfectDelta: delta,
      }).reason,
      'inexact',
    );
  });
});
