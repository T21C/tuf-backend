import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MONTHLY_NOMINEE_RATING_THRESHOLD,
  shouldEnqueueMonthlyNominee,
  utcMonthBounds,
  utcMonthKey,
} from './tufStellarNominee.js';

test('utcMonthKey formats UTC year-month', () => {
  assert.equal(utcMonthKey(new Date(Date.UTC(2026, 8, 22, 21, 0, 0))), '2026-09');
  assert.equal(utcMonthKey(new Date(Date.UTC(2026, 0, 1, 0, 0, 0))), '2026-01');
});

test('utcMonthBounds is the UTC calendar month half-open range', () => {
  const {start, next} = utcMonthBounds(new Date(Date.UTC(2026, 8, 22, 15, 30, 0)));
  assert.equal(start.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(next.toISOString(), '2026-10-01T00:00:00.000Z');
});

test('shouldEnqueueMonthlyNominee is true only on the 100th new official vote', () => {
  assert.equal(
    shouldEnqueueMonthlyNominee({
      isNewOfficialRaterVote: true,
      isAutorater: false,
      priorOfficialCountThisMonth: MONTHLY_NOMINEE_RATING_THRESHOLD - 1,
    }),
    true,
  );
});

test('shouldEnqueueMonthlyNominee skips edits, community-style updates, and autorater', () => {
  assert.equal(
    shouldEnqueueMonthlyNominee({
      isNewOfficialRaterVote: false,
      isAutorater: false,
      priorOfficialCountThisMonth: 99,
    }),
    false,
  );
  assert.equal(
    shouldEnqueueMonthlyNominee({
      isNewOfficialRaterVote: true,
      isAutorater: true,
      priorOfficialCountThisMonth: 99,
    }),
    false,
  );
});

test('shouldEnqueueMonthlyNominee skips counts other than 99 prior official votes', () => {
  assert.equal(
    shouldEnqueueMonthlyNominee({
      isNewOfficialRaterVote: true,
      isAutorater: false,
      priorOfficialCountThisMonth: 98,
    }),
    false,
  );
  assert.equal(
    shouldEnqueueMonthlyNominee({
      isNewOfficialRaterVote: true,
      isAutorater: false,
      priorOfficialCountThisMonth: 100,
    }),
    false,
  );
});
