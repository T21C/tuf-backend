import assert from 'node:assert/strict';
import test from 'node:test';

import {buildTournamentIndexDocument, buildTournamentSearchText} from './tournamentIndexDocument.js';

const sample = {
  id: 3,
  shortName: 'TUF Cup',
  fullName: 'The Universal Forums Cup',
  aka: 'TUFC',
  notes: 'Season notes',
  status: 'completed',
  isHidden: false,
  series: {id: 1, slug: 'tuf-cup', name: 'TUF Cup Series', sortWeight: 1},
  organizers: ['Alice Org'],
  placements: [
    {
      displayName: 'Display Player',
      teamName: 'Team Nova',
      player: {id: 11, name: 'Player One'},
      creator: {id: 22, name: 'Creator Two'},
      level: {id: 33, song: 'Firestorm', artist: 'DJ Blaze'},
      creditPlayers: [{id: 44, name: 'Credit Player'}],
      creditCreators: [{id: 55, name: 'Credit Creator'}],
    },
  ],
};

void test('buildTournamentSearchText includes players, creators, and levels', () => {
  const text = buildTournamentSearchText(sample);
  assert.equal(text.includes('process.env'), false);
  assert.equal(text.includes('Player One'), true);
  assert.equal(text.includes('Creator Two'), true);
  assert.equal(text.includes('Firestorm'), true);
  assert.equal(text.includes('DJ Blaze'), true);
  assert.equal(text.includes('Credit Player'), true);
  assert.equal(text.includes('Credit Creator'), true);
  assert.equal(text.includes('Team Nova'), true);
  assert.equal(text.includes('TUF Cup Series'), true);
});

void test('buildTournamentIndexDocument copies filter fields without env', () => {
  const doc = buildTournamentIndexDocument(sample);
  assert.equal(doc.id, 3);
  assert.equal(doc.isHidden, false);
  assert.equal(doc.status, 'completed');
  assert.equal(doc.seriesSortWeight, 1);
  assert.equal(doc.searchText.includes('Player One'), true);
  assert.equal(JSON.stringify(doc).includes('process.env'), false);
});
