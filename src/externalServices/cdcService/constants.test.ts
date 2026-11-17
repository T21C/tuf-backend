import assert from 'node:assert/strict';
import test from 'node:test';

import {CDC_WATCHED_TABLES} from './constants.js';

void test('CDC watches mods catalog tables', () => {
  assert.equal(CDC_WATCHED_TABLES.includes('mods'), true);
  assert.equal(CDC_WATCHED_TABLES.includes('mod_assignees'), true);
  assert.equal(CDC_WATCHED_TABLES.includes('mod_versions'), true);
  assert.equal(CDC_WATCHED_TABLES.includes('mod_tags'), true);
  assert.equal(CDC_WATCHED_TABLES.includes('mod_tag_assignments'), true);
  assert.equal(CDC_WATCHED_TABLES.includes('mod_likes'), true);
  assert.equal(CDC_WATCHED_TABLES.includes('mod_download_uniques'), false);
});

void test('CDC watches tournament catalog tables', () => {
  assert.equal(CDC_WATCHED_TABLES.includes('tournaments'), true);
  assert.equal(CDC_WATCHED_TABLES.includes('tournament_series'), true);
  assert.equal(CDC_WATCHED_TABLES.includes('tournament_tiers'), true);
  assert.equal(CDC_WATCHED_TABLES.includes('tournament_placements'), true);
  assert.equal(CDC_WATCHED_TABLES.includes('tournament_placement_credits'), true);
});

void test('CDC watches pending submission queue tables', () => {
  assert.equal(CDC_WATCHED_TABLES.includes('pass_submissions'), true);
  assert.equal(CDC_WATCHED_TABLES.includes('level_submissions'), true);
  assert.equal(CDC_WATCHED_TABLES.includes('teams'), true);
  assert.equal(CDC_WATCHED_TABLES.includes('team_aliases'), true);
  assert.equal(CDC_WATCHED_TABLES.includes('level_submission_creator_requests'), true);
});
