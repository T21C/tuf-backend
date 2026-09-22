import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_LEVEL_CHART_STATS } from '@/misc/utils/data/chartCacheParse.js';
import {
  chartStatsFromLevel,
  classifyPreviousSource,
  extractZipFilesSnapshot,
  oldChartStatsForPreviousSource,
  previousSourceHostname,
  resolveUploadSource,
} from './levelFileDiscordSnapshot.js';

test('classifyPreviousSource treats Drive hosts as google_drive', () => {
  assert.equal(
    classifyPreviousSource('https://drive.google.com/file/d/abc/view?usp=sharing', false),
    'google_drive',
  );
  assert.equal(
    classifyPreviousSource('https://drive.usercontent.google.com/download?id=abc', false),
    'google_drive',
  );
  assert.equal(classifyPreviousSource('https://dropbox.com/s/x/file.zip', false), 'external');
  assert.equal(classifyPreviousSource('https://api.tuforums.com/cdn/abc', true), 'cdn');
});

test('previousSourceHostname reads the host', () => {
  assert.equal(previousSourceHostname('https://files.example.com/a.zip'), 'files.example.com');
  assert.equal(previousSourceHostname('not a url'), null);
});

test('resolveUploadSource defaults to level_edit', () => {
  assert.equal(resolveUploadSource('upload_from_url'), 'upload_from_url');
  assert.equal(resolveUploadSource('  '), 'level_edit');
  assert.equal(resolveUploadSource(null), 'level_edit');
});

test('oldChartStatsForPreviousSource blanks non-cdn stats', () => {
  const level = {
    bpm: 180,
    tilecount: 400,
    midspinCount: 2,
    autoTileCount: 1,
    levelLengthInMs: 90000,
  };
  assert.deepEqual(oldChartStatsForPreviousSource('google_drive', level), EMPTY_LEVEL_CHART_STATS);
  assert.deepEqual(oldChartStatsForPreviousSource('external', level), EMPTY_LEVEL_CHART_STATS);
  assert.equal(oldChartStatsForPreviousSource('cdn', level).tilecount, 400);
});

test('chartStatsFromLevel floors integer fields and ignores junk', () => {
  assert.deepEqual(
    chartStatsFromLevel({
      bpm: 175.5,
      tilecount: 12.9,
      midspinCount: Number.NaN,
      autoTileCount: 3,
      levelLengthInMs: 1234,
    }),
    {
      bpm: 175.5,
      tilecount: 12,
      midspinCount: null,
      autoTileCount: 3,
      levelLengthInMs: 1234,
    },
  );
});

test('extractZipFilesSnapshot reads wrapped CDN metadata', () => {
  const snapshot = extractZipFilesSnapshot({
    metadata: {
      allLevelFiles: [
        { name: 'b.adofai', relativePath: 'pack/b.adofai' },
        { name: 'a.adofai', relativePath: 'a.adofai' },
      ],
      songFiles: {
        'pack/song.ogg': { name: 'song.ogg' },
        preview: { name: 'preview.mp3' },
      },
      targetLevelRelativePath: 'pack/b.adofai',
    },
  });
  assert.equal(snapshot.charts.length, 2);
  assert.equal(snapshot.charts[0].relativePath, 'a.adofai');
  assert.equal(snapshot.audio.length, 2);
  assert.equal(snapshot.audio[0].name, 'preview.mp3');
  assert.equal(snapshot.targetRelativePath, 'pack/b.adofai');
});

test('extractZipFilesSnapshot falls back to getLevelFiles-shaped list', () => {
  const snapshot = extractZipFilesSnapshot(null, [
    { name: 'main.adofai', relativePath: 'main.adofai' },
  ]);
  assert.deepEqual(snapshot.charts, [{ name: 'main.adofai', relativePath: 'main.adofai' }]);
  assert.deepEqual(snapshot.audio, []);
  assert.equal(snapshot.targetRelativePath, null);
});
