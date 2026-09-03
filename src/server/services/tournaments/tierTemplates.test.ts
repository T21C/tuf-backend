import assert from 'node:assert/strict';
import test from 'node:test';

import {parsePrizeCode} from './tierTemplates.js';

void test('parsePrizeCode reads ordinals and WD/DQ suffixes', () => {
  assert.deepEqual(parsePrizeCode('1st'), {code: '1', withdrew: false, disqualified: false});
  assert.deepEqual(parsePrizeCode('RO8WD'), {code: 'RO8', withdrew: true, disqualified: false});
  assert.deepEqual(parsePrizeCode('RO8DQ'), {code: 'RO8', withdrew: false, disqualified: true});
  assert.deepEqual(parsePrizeCode('4DQ'), {code: '4', withdrew: false, disqualified: true});
  assert.deepEqual(parsePrizeCode(''), {code: '', withdrew: false, disqualified: false});
});
