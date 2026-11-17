import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NOTIFICATION_TYPES, getNotificationTypeDefinition} from './types.js';

test('chart.cleared is opt-in for in-app by default', () => {
  const definition = getNotificationTypeDefinition(NOTIFICATION_TYPES.ChartCleared);
  assert.equal(definition.defaults.inApp, false);
  assert.equal(definition.category, 'chart');
  assert.equal(
    definition.href({
      passId: 9,
      levelId: 12,
      song: null,
      artist: null,
      playerId: 3,
      playerName: null,
    }),
    '/passes/9',
  );
});

test('chart.swapped links to the level that now holds the chart', () => {
  const definition = getNotificationTypeDefinition(NOTIFICATION_TYPES.ChartSwapped);
  assert.equal(definition.defaults.inApp, true);
  assert.equal(definition.category, 'chart');
  assert.equal(
    definition.href({
      levelId: 16786,
      song: '脱社会ヴァンダリズム独白if',
      artist: 'katagiri',
      swappedWithLevelId: 16796,
      swappedWithSong: 'Other',
      swappedWithArtist: 'Someone',
    }),
    '/levels/16786',
  );
});

test('reference.changed is in-app by default and links to the level', () => {
  const definition = getNotificationTypeDefinition(NOTIFICATION_TYPES.ReferenceChanged);
  assert.equal(definition.defaults.inApp, true);
  assert.equal(definition.category, 'references');
  assert.equal(
    definition.href({
      kind: 'file',
      levelId: 3042,
      song: 'Storm',
      artist: 'Camellia',
      difficultyNames: 'P13',
    }),
    '/levels/3042',
  );
});

test('chart.rated is in-app by default and links to the level', () => {
  const definition = getNotificationTypeDefinition(NOTIFICATION_TYPES.ChartRated);
  assert.equal(definition.defaults.inApp, true);
  assert.equal(definition.category, 'chart');
  assert.equal(
    definition.href({
      levelId: 12,
      song: 'Storm',
      artist: 'Camellia',
      difficultyName: 'U1',
    }),
    '/levels/12',
  );
});

test('chart.rerated is in-app by default and links to the level', () => {
  const definition = getNotificationTypeDefinition(NOTIFICATION_TYPES.ChartRerated);
  assert.equal(definition.defaults.inApp, true);
  assert.equal(definition.category, 'chart');
  assert.equal(
    definition.href({
      levelId: 12,
      song: 'Storm',
      artist: 'Camellia',
      previousDifficultyName: 'U1',
      difficultyName: 'U2',
    }),
    '/levels/12',
  );
});

test('pass.level.rerated is in-app by default in clears and links to the level', () => {
  const definition = getNotificationTypeDefinition(NOTIFICATION_TYPES.PassLevelRerated);
  assert.equal(definition.defaults.inApp, true);
  assert.equal(definition.category, 'clears');
  assert.equal(
    definition.href({
      levelId: 12,
      song: 'Storm',
      artist: 'Camellia',
      previousDifficultyName: 'U1',
      difficultyName: 'U2',
    }),
    '/levels/12',
  );
});
