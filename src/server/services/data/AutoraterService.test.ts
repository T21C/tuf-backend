import assert from 'node:assert/strict';
import {after, test, type TestContext} from 'node:test';
import axios from 'axios';
import Rating from '@/models/levels/Rating.js';
import RatingDetail from '@/models/levels/RatingDetail.js';
import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';

const testEnv = {
  AUTORATER_UUID: 'preview-bot', CDN_URL: 'http://127.0.0.1:1',
  JOB_PROGRESS_INGEST_SECRET: 'test-only', CDN_INGEST_SECRET: 'test-only',
};
const previousEnv = Object.fromEntries(Object.keys(testEnv).map(key => [key, process.env[key]]));
Object.assign(process.env, testEnv);
const {autoraterService} = await import('./AutoraterService.js');
after(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const response = {
  tufid: 17158, rating_result: 'U7 high (U8, U7, U6, U7)',
  avg: 'U7 high', rr: 'U8', v2: 'U7', v21: 'U6', v22: 'U7',
};

function setup(t: TestContext) {
  t.mock.timers.enable({apis: ['setTimeout']});
  const transaction = {
    LOCK: {UPDATE: 'UPDATE'}, commit: t.mock.fn(async () => {}), rollback: t.mock.fn(async () => {}),
  };
  const begin = t.mock.method(Rating.sequelize!, 'transaction', async () => transaction);
  const rating = {id: 14577, levelId: 17158, confirmedAt: null};
  const findRating = t.mock.method(Rating, 'findByPk', async () => rating);
  t.mock.method(Level, 'findByPk', async () => ({id: 17158, isHidden: false, isDeleted: false}));
  const save = t.mock.method(RatingDetail, 'upsert', async () => []);
  t.mock.method(RatingDetail, 'findAll', async () => [{isCommunityRating: false,
    dataValues: {userId: 'preview-bot', rating: response.rating_result}}]);
  t.mock.method(Difficulty, 'findAll', async () => [
    {id: 47, name: 'U7', sortOrder: 51, type: 'PGU'},
    {id: 48, name: 'U8', sortOrder: 52, type: 'PGU'},
  ]);
  const update = t.mock.method(Rating, 'update', async () => [1]);
  const request = t.mock.method(axios, 'get', async (url: string, options: {params: {tufid: number}; timeout: number}) => {
    assert.ok(url.endsWith('/rating-result'));
    assert.equal(options.params.tufid, 17158);
    assert.equal(options.timeout, 190000);
    assert.equal(begin.mock.callCount(), 0, 'inference must not hold a database transaction');
    return {status: 200, data: response};
  });
  return {transaction, begin, rating, findRating, save, update, request};
}

test('persists the display string, clears legacy reason, and calculates a single AVG vote atomically', async t => {
  const state = setup(t);
  await autoraterService.autorateRating(14577);
  const args = state.save.mock.calls[0].arguments as unknown[];
  assert.deepEqual(args[0], {ratingId: 14577, userId: 'preview-bot', rating: response.rating_result, comment: '', isCommunityRating: false});
  assert.deepEqual(args[1], {transaction: state.transaction});
  const update = state.update.mock.calls[0].arguments as unknown[];
  assert.deepEqual(update[0], {averageDifficultyId: 47, communityDifficultyId: null});
  assert.equal(state.transaction.commit.mock.callCount(), 1);
  assert.equal(state.transaction.rollback.mock.callCount(), 0);
});

test('invalid upstream results do not replace the existing rating', async t => {
  const state = setup(t);
  state.request.mock.mockImplementation(async () => ({status: 200, data: {...response, tufid: 16931}}));
  await assert.rejects(autoraterService.autorateRating(14577), {statusCode: 502});
  assert.equal(state.save.mock.callCount(), 0);
  assert.equal(state.begin.mock.callCount(), 0);
});

const keptRatingMessage = 'The previous rating has been kept.';
const fallbackErrorMessage = `Failed to autorate level. ${keptRatingMessage}`;

for (const {name, data, reason, upstreamStatus, statusCode} of [
  {
    name: 'structured API detail takes precedence over generic fields',
    data: {detail: {code: 'unsupported_download', message: 'The level needs an HTTP(S) chart download link.'},
      error: 'Generic error', message: 'Generic message'},
    reason: 'The level needs an HTTP(S) chart download link.', upstreamStatus: 422, statusCode: 422,
  },
  {
    name: 'string API detail', data: {detail: 'The rating queue is full. Retry shortly.'},
    reason: 'The rating queue is full. Retry shortly.', upstreamStatus: 503, statusCode: 503,
  },
  {
    name: 'top-level error', data: {error: 'This level has no supported TUF CDN download link.'},
    reason: 'This level has no supported TUF CDN download link.', upstreamStatus: 422, statusCode: 422,
  },
  {
    name: 'top-level message', data: {message: 'No TUF level exists with this ID.'},
    reason: 'No TUF level exists with this ID.', upstreamStatus: 404, statusCode: 404,
  },
  {
    name: 'blank or non-string fields fall through to a usable message',
    data: {detail: {message: '  '}, error: {code: 'file_too_large'}, message: '  The chart is too large.  '},
    reason: 'The chart is too large.', upstreamStatus: 413, statusCode: 413,
  },
  {
    name: 'upstream timeout detail', data: {detail: {code: 'rating_timeout', message: 'The rating timed out.'}},
    reason: 'The rating timed out.', upstreamStatus: 504, statusCode: 504,
  },
  {
    name: 'unexpected upstream status keeps the existing gateway mapping',
    data: {detail: 'An unexpected rating error occurred.'},
    reason: 'An unexpected rating error occurred.', upstreamStatus: 500, statusCode: 502,
  },
]) {
  test(`shows ${name} without replacing the previous rating`, async t => {
    const state = setup(t);
    state.request.mock.mockImplementation(async () => {
      throw new axios.AxiosError('Request failed', 'ERR_BAD_RESPONSE', undefined, undefined, {
        status: upstreamStatus, data, statusText: '', headers: {}, config: {headers: new axios.AxiosHeaders()},
      });
    });
    await assert.rejects(autoraterService.autorateRating(14577), {
      name: 'AutoraterError', statusCode, message: `${reason} ${keptRatingMessage}`,
    });
    assert.equal(state.begin.mock.callCount(), 0);
    assert.equal(state.save.mock.callCount(), 0);
    assert.equal(state.update.mock.callCount(), 0);
    assert.equal(state.transaction.commit.mock.callCount(), 0);
  });
}

for (const [name, data] of Object.entries({
  absent: undefined,
  null: null,
  html: '<html>Bad Gateway</html>',
  empty: {},
  blank: {detail: {message: '  '}, error: '', message: '\n'},
  malformed: {detail: {message: 42}, error: {message: 'Nested error'}, message: ['Array message']},
  validation: {detail: [{msg: 'Invalid input', input: 'Must not be reflected'}]},
})) {
  test(`uses the fallback for ${name} upstream data without replacing the previous rating`, async t => {
    const state = setup(t);
    state.request.mock.mockImplementation(async () => {
      throw new axios.AxiosError('Request failed', 'ERR_BAD_RESPONSE', undefined, undefined, {
        status: 502, data, statusText: '', headers: {}, config: {headers: new axios.AxiosHeaders()},
      });
    });
    await assert.rejects(autoraterService.autorateRating(14577), {
      statusCode: 502, message: fallbackErrorMessage,
    });
    assert.equal(state.begin.mock.callCount(), 0);
    assert.equal(state.save.mock.callCount(), 0);
    assert.equal(state.update.mock.callCount(), 0);
  });
}

test('network failures keep the previous result and use the fallback message', async t => {
  const state = setup(t);
  state.request.mock.mockImplementation(async () => { throw new axios.AxiosError('Connection refused', 'ECONNREFUSED'); });
  await assert.rejects(autoraterService.autorateRating(14577), {statusCode: 502, message: fallbackErrorMessage});
  assert.equal(state.begin.mock.callCount(), 0);
  assert.equal(state.save.mock.callCount(), 0);
  assert.equal(state.update.mock.callCount(), 0);
});

test('upstream timeouts keep the previous result and return a retryable error', async t => {
  const state = setup(t);
  state.request.mock.mockImplementation(async () => { throw new axios.AxiosError('timeout', 'ECONNABORTED'); });
  await assert.rejects(autoraterService.autorateRating(14577), {statusCode: 504, message: fallbackErrorMessage});
  assert.equal(state.begin.mock.callCount(), 0);
  assert.equal(state.save.mock.callCount(), 0);
  assert.equal(state.update.mock.callCount(), 0);
});

test('settlement during inference prevents the write', async t => {
  const state = setup(t);
  state.findRating.mock.mockImplementationOnce(async () => ({...state.rating, confirmedAt: new Date()}), 1);
  await assert.rejects(autoraterService.autorateRating(14577), {statusCode: 409});
  assert.equal(state.save.mock.callCount(), 0);
  assert.equal(state.transaction.rollback.mock.callCount(), 1);
});

test('a failure after upsert rolls back the detail and averages together', async t => {
  const state = setup(t);
  state.update.mock.mockImplementation(async () => { throw new Error('database unavailable'); });
  await assert.rejects(autoraterService.autorateRating(14577), {statusCode: 500});
  assert.equal(state.save.mock.callCount(), 1);
  assert.equal(state.transaction.commit.mock.callCount(), 0);
  assert.equal(state.transaction.rollback.mock.callCount(), 1);
});
