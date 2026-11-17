import assert from 'node:assert/strict';
import test from 'node:test';
import {permissionFlags} from '@/config/constants.js';
import {canAccessAnnouncementKind, canAnnounceCurations} from './announcementAccess.js';

const curator = {permissionFlags: permissionFlags.CURATOR};
const headCurator = {permissionFlags: permissionFlags.HEAD_CURATOR};
const superAdmin = {permissionFlags: permissionFlags.SUPER_ADMIN};
const rater = {permissionFlags: permissionFlags.RATER};

test('only head curators and super admins can announce curations', () => {
  assert.equal(canAnnounceCurations(curator), false);
  assert.equal(canAnnounceCurations(headCurator), true);
  assert.equal(canAnnounceCurations(superAdmin), true);
  assert.equal(canAnnounceCurations(rater), false);
  assert.equal(canAnnounceCurations(null), false);
});

test('head curators can open only curation announcement kinds', () => {
  assert.equal(canAccessAnnouncementKind(curator, 'curation'), false);
  assert.equal(canAccessAnnouncementKind(curator, 'curation_rerate'), false);
  assert.equal(canAccessAnnouncementKind(headCurator, 'curation'), true);
  assert.equal(canAccessAnnouncementKind(headCurator, 'curation_rerate'), true);
  assert.equal(canAccessAnnouncementKind(headCurator, 'level'), false);
  assert.equal(canAccessAnnouncementKind(headCurator, 'rerate'), false);
  assert.equal(canAccessAnnouncementKind(headCurator, 'pass'), false);
});

test('super admins can open every announcement kind', () => {
  for (const kind of ['curation', 'curation_rerate', 'level', 'rerate', 'pass']) {
    assert.equal(canAccessAnnouncementKind(superAdmin, kind), true);
  }
});
