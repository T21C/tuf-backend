import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  ADOFAI_VERSION,
  canUseXPerfectMode,
  isLegacyAdofaiVersion,
  parseAdofaiVersion,
  resolveAdofaiVersionFromTimestamp,
} from './adofaiVersion.js';

describe('adofaiVersion', () => {
  it('parses frozen ids and rejects unknown', () => {
    assert.equal(parseAdofaiVersion(1), ADOFAI_VERSION.V2);
    assert.equal(parseAdofaiVersion('3'), ADOFAI_VERSION.V3_4_0);
    assert.equal(parseAdofaiVersion(99), ADOFAI_VERSION.PRE_3_4_0);
  });

  it('classifies legacy vs xperfect eras', () => {
    assert.equal(isLegacyAdofaiVersion(ADOFAI_VERSION.V2), true);
    assert.equal(isLegacyAdofaiVersion(ADOFAI_VERSION.PRE_3_4_0), true);
    assert.equal(isLegacyAdofaiVersion(ADOFAI_VERSION.V3_4_0), false);
    assert.equal(canUseXPerfectMode(ADOFAI_VERSION.V3_4_0), true);
    assert.equal(canUseXPerfectMode(ADOFAI_VERSION.PRE_3_4_0), false);
  });

  it('resolves cutoffs in UTC', () => {
    assert.equal(resolveAdofaiVersionFromTimestamp('2026-04-30T23:59:59Z'), ADOFAI_VERSION.V2);
    assert.equal(resolveAdofaiVersionFromTimestamp('2026-05-01T00:00:00Z'), ADOFAI_VERSION.PRE_3_4_0);
    assert.equal(resolveAdofaiVersionFromTimestamp('2026-09-11T07:59:59Z'), ADOFAI_VERSION.PRE_3_4_0);
    assert.equal(resolveAdofaiVersionFromTimestamp('2026-09-11T08:00:00Z'), ADOFAI_VERSION.V3_4_0);
    assert.equal(resolveAdofaiVersionFromTimestamp(null), ADOFAI_VERSION.V3_4_0);
  });
});
