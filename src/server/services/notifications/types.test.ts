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
