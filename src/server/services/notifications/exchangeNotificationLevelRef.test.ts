import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exchangeNotificationLevelRef} from './exchangeNotificationLevelRef.js';

test('exchanges levelId so the link follows the chart, and keeps the song snapshot', () => {
  const exchanged = exchangeNotificationLevelRef(
    {
      payload: {levelId: 16796, song: '脱社会ヴァンダリズム独白if', artist: 'katagiri', passId: 16796},
      entityType: 'level',
      entityId: '16796',
    },
    16786,
    16796,
  );

  assert.equal(exchanged.changed, true);
  assert.deepEqual(exchanged.payload, {
    levelId: 16786,
    song: '脱社会ヴァンダリズム独白if',
    artist: 'katagiri',
    passId: 16796,
  });
  assert.equal(exchanged.entityId, '16786');
});

test('exchanges both ids on a swap notification without inventing fields', () => {
  const fromA = exchangeNotificationLevelRef(
    {
      payload: {
        levelId: 16786,
        song: 'A',
        artist: 'one',
        swappedWithLevelId: 16796,
        swappedWithSong: 'B',
        swappedWithArtist: 'two',
      },
      entityType: 'level',
      entityId: '16786',
    },
    16786,
    16796,
  );
  assert.deepEqual(fromA.payload, {
    levelId: 16796,
    song: 'A',
    artist: 'one',
    swappedWithLevelId: 16786,
    swappedWithSong: 'B',
    swappedWithArtist: 'two',
  });

  const plain = exchangeNotificationLevelRef(
    {
      payload: {levelId: 12, song: 'Storm', artist: 'Camellia'},
      entityType: 'pass',
      entityId: '16786',
    },
    16786,
    16796,
  );
  assert.equal(plain.changed, false);
  assert.equal((plain.payload as {levelId: number}).levelId, 12);
  assert.equal(plain.entityId, '16786');
});
