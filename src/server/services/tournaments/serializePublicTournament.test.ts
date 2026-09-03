import assert from 'node:assert/strict';
import test from 'node:test';

import {permissionFlags} from '../../../config/constants.js';
import {
  canEditPublicTournament,
  canViewTournamentDetail,
  isPubliclyListedTournament,
  parseHashIdSearch,
  parsePublicTournamentStatus,
  serializePublicPlacement,
  serializePublicTournamentDetail,
} from './serializePublicTournament.js';

const sadmin = {id: 'admin-1', permissionFlags: String(permissionFlags.SUPER_ADMIN)};
const owner = {id: 'owner-1', permissionFlags: '0'};
const stranger = {id: 'stranger-1', permissionFlags: '0'};

void test('parseHashIdSearch reads #id and rejects other queries', () => {
  assert.equal(parseHashIdSearch('#42'), 42);
  assert.equal(parseHashIdSearch('  #7  '), 7);
  assert.equal(parseHashIdSearch('#0'), null);
  assert.equal(parseHashIdSearch('42'), null);
  assert.equal(parseHashIdSearch('#abc'), null);
});

void test('parsePublicTournamentStatus accepts listed public statuses', () => {
  assert.equal(parsePublicTournamentStatus('ongoing'), 'ongoing');
  assert.equal(parsePublicTournamentStatus('completed'), 'completed');
  assert.equal(parsePublicTournamentStatus('cancelled'), 'cancelled');
  assert.equal(parsePublicTournamentStatus('draft'), null);
  assert.equal(parsePublicTournamentStatus('nope'), null);
});

void test('isPubliclyListedTournament excludes hidden and draft', () => {
  assert.equal(isPubliclyListedTournament({isHidden: false, status: 'ongoing'}), true);
  assert.equal(isPubliclyListedTournament({isHidden: false, status: 'cancelled'}), true);
  assert.equal(isPubliclyListedTournament({isHidden: true, status: 'completed'}), false);
  assert.equal(isPubliclyListedTournament({isHidden: false, status: 'draft'}), false);
});

void test('canViewTournamentDetail allows owners and super-admins for hidden and draft', () => {
  const hidden = {isHidden: true, status: 'completed', ownerUserIds: ['owner-1']};
  const draft = {isHidden: false, status: 'draft', ownerUserIds: ['owner-1']};
  assert.equal(canViewTournamentDetail(hidden, null), false);
  assert.equal(canViewTournamentDetail(hidden, stranger), false);
  assert.equal(canViewTournamentDetail(hidden, owner), true);
  assert.equal(canViewTournamentDetail(hidden, sadmin), true);
  assert.equal(canViewTournamentDetail(draft, stranger), false);
  assert.equal(canViewTournamentDetail(draft, owner), true);
  assert.equal(canViewTournamentDetail({isHidden: false, status: 'ongoing'}, null), true);
});

void test('canEditPublicTournament is owner or super-admin', () => {
  const tournament = {ownerUserIds: ['owner-1']};
  assert.equal(canEditPublicTournament(tournament, null), false);
  assert.equal(canEditPublicTournament(tournament, stranger), false);
  assert.equal(canEditPublicTournament(tournament, owner), true);
  assert.equal(canEditPublicTournament(tournament, sadmin), true);
});

void test('serializePublicPlacement includes player pfp and nested user avatarUrl', () => {
  const dto = serializePublicPlacement({
    id: 1,
    displayName: 'Ada',
    playerId: 7,
    player: {
      id: 7,
      name: 'Ada',
      pfp: 'https://cdn.example/ada-pfp.jpg',
      user: {avatarUrl: 'https://cdn.example/ada-avatar.jpg'},
    },
    positionInTier: 1,
  });
  assert.ok(dto);
  assert.equal(dto.player?.pfp, 'https://cdn.example/ada-pfp.jpg');
  assert.equal(dto.player?.avatarUrl, 'https://cdn.example/ada-avatar.jpg');
});

void test('serializePublicPlacement includes level diffId', () => {
  const dto = serializePublicPlacement(
    {
      id: 4,
      displayName: 'Song',
      levelId: 12,
      rowMode: 'level',
      level: {id: 12, song: 'Song', artist: 'Artist', diffId: 8},
      positionInTier: 1,
    },
    'level',
  );
  assert.ok(dto);
  assert.equal(dto.level?.id, 12);
  assert.equal(dto.level?.diffId, 8);
});

void test('serializePublicTournamentDetail includes pending, withdrew, and disqualified placements', () => {
  const dto = serializePublicTournamentDetail(
    {
      id: 9,
      shortName: 'Cup',
      status: 'completed',
      isHidden: false,
      placements: [
        {id: 1, displayName: 'Pending player', isPending: true, withdrew: false, positionInTier: 1},
        {id: 2, displayName: 'Withdrew player', isPending: false, withdrew: true, positionInTier: 2},
        {
          id: 3,
          displayName: 'Disqualified player',
          isPending: false,
          withdrew: false,
          disqualified: true,
          positionInTier: 3,
        },
      ],
    },
    {canEdit: true},
  );
  assert.ok(dto);
  assert.equal(dto.canEdit, true);
  assert.equal(dto.placements.length, 3);
  const pending = dto.placements[0];
  const withdrew = dto.placements[1];
  const disqualified = dto.placements[2];
  assert.ok(pending);
  assert.ok(withdrew);
  assert.ok(disqualified);
  assert.equal(pending.isPending, true);
  assert.equal(withdrew.withdrew, true);
  assert.equal(disqualified.disqualified, true);
  assert.equal(disqualified.withdrew, false);
});
