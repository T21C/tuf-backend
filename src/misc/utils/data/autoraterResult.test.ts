import assert from 'node:assert/strict';
import test from 'node:test';
import {validateAutoraterResult, ratingForAverage} from './autoraterResult.js';

const result = {
  tufid: 17158, rating_result: 'U7 high (U8, U7, U6, U7)',
  avg: 'U7 high', rr: 'U8', v2: 'U7', v21: 'U6', v22: 'U7',
};

test('keeps the API display string exactly and checks the requested level', () => {
  assert.equal(validateAutoraterResult(result, 17158), result);
  assert.throws(() => validateAutoraterResult(result, 16931));
  for (const invalid of [null, {}, {...result, v22: null}, {...result, avg: 'U70 high'},
    {...result, rating_result: 'U7 high (U6, U7, U8, U7)'}, {...result, rr: '<iframe>'}]) {
    assert.throws(() => validateAutoraterResult(invalid, 17158));
  }
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
