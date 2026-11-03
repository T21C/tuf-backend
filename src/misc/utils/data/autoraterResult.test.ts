import assert from 'node:assert/strict';
import test from 'node:test';
import {autoraterLean, autoraterModelLabels, validateAutoraterResult, ratingForAverage} from './autoraterResult.js';

const result = {
  tufid: 17158, rating_result: 'U7 high (U8, U7, U6, U7)',
  avg: 'U7 high', rr: 'U8', v2: 'U7', v21: 'U6', v22: 'U7',
};

test('accepts P0 without changing the display string or counting model labels as votes', () => {
  const p0 = {tufid: 17663, avg: 'P0', rr: 'P0', v2: 'P0', v21: 'P0', v22: 'P0',
    rating_result: 'P0 (P0, P0, P0, P0)'};
  assert.equal(validateAutoraterResult(p0, 17663), p0);
  assert.equal(ratingForAverage(p0.rating_result, 'bot', 'bot'), 'P0');
  assert.deepEqual(autoraterModelLabels(p0.rating_result), ['P0', 'P0', 'P0', 'P0']);
  assert.equal(autoraterLean(p0.rating_result), null);
  const mixed = {...result, rr: 'P0', rating_result: 'U7 high (P0, U7, U6, U7)'};
  assert.equal(validateAutoraterResult(mixed, 17158), mixed);
  for (const invalid of [
    {...p0, tufid: 1}, {...p0, v22: null}, {...p0, rr: 'P1'},
    ...['G0', 'U0', 'P00', 'P21', 'P-1'].map(label => ({...p0, avg: label,
      rr: label, v2: label, v21: label, v22: label,
      rating_result: `${label} (${label}, ${label}, ${label}, ${label})`})),
  ]) assert.throws(() => validateAutoraterResult(invalid, 17663));
});

test('keeps the API display string exactly and checks the requested level', () => {
  assert.equal(validateAutoraterResult(result, 17158), result);
  assert.throws(() => validateAutoraterResult(result, 16931));
  for (const invalid of [null, {}, {...result, v22: null}, {...result, avg: 'U70 high'},
    {...result, rating_result: 'U7 high (U6, U7, U8, U7)'}, {...result, rr: '<iframe>'}]) {
    assert.throws(() => validateAutoraterResult(invalid, 17158));
  }
});

test('autoraterLean reads low mid high from AVG and display strings', () => {
  assert.equal(autoraterLean(result.rating_result), 'high');
  assert.equal(autoraterLean('P1 high (P1, P2, P1, P1)'), 'high');
  assert.equal(autoraterLean('P12 low'), 'low');
  assert.equal(autoraterLean('G20 mid (G19, U1, G20, G20)'), 'mid');
  assert.equal(autoraterLean('P12'), null);
  assert.equal(autoraterLean('Impossible (Impossible, Impossible, Impossible, Impossible)'), null);
});

test('one AutoRater vote uses AVG, never averages the component models as a range', () => {
  assert.equal(ratingForAverage(result.rating_result, 'bot', 'bot'), 'U7');
  assert.equal(ratingForAverage('P1 low (P1, P1, P1, P1)', 'bot', 'bot'), 'P1');
  assert.equal(ratingForAverage('G20 mid (G19, U1, G20, G20)', 'bot', 'bot'), 'G20');
  assert.equal(ratingForAverage('Qq-Qq', 'bot', 'bot'), 'Qq-Qq');
  assert.equal(ratingForAverage(result.rating_result, 'human', 'bot'), result.rating_result);
  assert.equal(ratingForAverage(result.rating_result, 'bot'), result.rating_result);
});

test('special labels stay special and malformed strings are not silently repaired', () => {
  const special = {...result, avg: 'Impossible', rr: 'Impossible', v2: 'Impossible', v21: 'Impossible', v22: 'Impossible',
    rating_result: 'Impossible (Impossible, Impossible, Impossible, Impossible)'};
  validateAutoraterResult(special, 17158);
  assert.equal(ratingForAverage(special.rating_result, 'bot', 'bot'), 'Impossible');
  assert.equal(ratingForAverage('Censored (Censored, Censored, Censored, Censored)', 'bot', 'bot'), 'Censored');
  assert.equal(ratingForAverage('U7 high (U8)', 'bot', 'bot'), 'U7 high (U8)');
});
