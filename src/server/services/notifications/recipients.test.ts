import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectCreatorIdsForNotification} from './recipients.js';

test('owner fallback uses owners when present', () => {
  const ids = selectCreatorIdsForNotification([
    {creatorId: 1, isOwner: true, role: 'charter'},
    {creatorId: 2, isOwner: false, role: 'charter'},
    {creatorId: 3, isOwner: false, role: 'vfxer'},
  ]);
  assert.deepEqual(ids, [1]);
});

test('owner fallback uses charters when there is no owner', () => {
  const ids = selectCreatorIdsForNotification([
    {creatorId: 2, isOwner: false, role: 'charter'},
    {creatorId: 3, isOwner: false, role: 'vfxer'},
    {creatorId: 4, isOwner: false, role: 'specialThanks'},
  ]);
  assert.deepEqual(ids, [2]);
});

test('charter and vfxer roles exclude special thanks and ignore isOwner', () => {
  const ids = selectCreatorIdsForNotification(
    [
      {creatorId: 1, isOwner: true, role: 'specialThanks'},
      {creatorId: 2, isOwner: false, role: 'charter'},
      {creatorId: 3, isOwner: false, role: 'vfxer'},
      {creatorId: 4, isOwner: false, role: 'specialThanks'},
    ],
    ['charter', 'vfxer'],
  );
  assert.deepEqual(ids.sort((a, b) => a - b), [2, 3]);
});

test('role filter is case-insensitive and de-duplicates creator ids', () => {
  const ids = selectCreatorIdsForNotification(
    [
      {creatorId: 8, isOwner: false, role: 'Charter'},
      {creatorId: 8, isOwner: false, role: 'vfxer'},
      {creatorId: 9, isOwner: false, role: 'SPECIALTHANKS'},
    ],
    ['CHARTER', 'vfxer'],
  );
  assert.deepEqual(ids, [8]);
});
