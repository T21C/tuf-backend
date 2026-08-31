import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTournamentSearchQuery,
  buildTournamentTextShould,
  parseTournamentLimit,
  parseTournamentOffset,
} from './tournamentSearchQuery.js';
import {parseHashIdSearch} from '../../../tournaments/serializePublicTournament.js';

void test('buildTournamentSearchQuery filters hidden and draft for public search', () => {
  const empty = buildTournamentSearchQuery({});
  const asJson = JSON.stringify(empty);
  assert.equal(asJson.includes('isHidden'), true);
  assert.equal(asJson.includes('draft'), true);
  assert.equal(asJson.includes('process.env'), false);

  const includeAll = buildTournamentSearchQuery({includeHidden: true, includeDraft: true});
  assert.deepEqual(includeAll, {match_all: {}});
});

void test('buildTournamentSearchQuery applies status and text should clauses', () => {
  const queried = buildTournamentSearchQuery({q: 'nova', status: 'ongoing'});
  const asJson = JSON.stringify(queried);
  assert.equal((queried as {bool: {minimum_should_match: number}}).bool.minimum_should_match, 1);
  assert.equal(asJson.includes('ongoing'), true);
  assert.equal(asJson.includes('nova'), true);
  assert.equal(asJson.includes('process.env'), false);
  assert.ok(buildTournamentTextShould('nova').length > 0);
});

void test('hash id search is exact and separate from text query', () => {
  assert.equal(parseHashIdSearch('#123'), 123);
  assert.equal(parseHashIdSearch('123'), null);
});

void test('parseTournamentOffset and parseTournamentLimit use numeric defaults without env', () => {
  assert.equal(parseTournamentOffset(undefined), 0);
  assert.equal(parseTournamentOffset('-4'), 0);
  assert.equal(parseTournamentLimit(undefined), 200);
  assert.equal(parseTournamentLimit('0'), 1);
  assert.equal(parseTournamentLimit('9999'), 500);
});
