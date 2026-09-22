import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_LEVEL_CHART_STATS } from '@/misc/utils/data/chartCacheParse.js';
import {
  DISCORD_FIELD_VALUE_MAX,
  formatChartStatsDiff,
  formatChartStatsNew,
  formatLengthMs,
  formatPreviousSourceField,
  formatUploadSource,
  formatZipFilesField,
  formatZipSize,
} from './levelFileEmbed.js';

test('formatUploadSource maps known sources', () => {
  assert.equal(formatUploadSource('level_edit'), 'Level editor');
  assert.equal(formatUploadSource('upload_from_url'), 'URL import');
  assert.equal(formatUploadSource('mojibake_metadata_migrate'), 'Mojibake migration');
  assert.equal(formatUploadSource('custom_job'), 'custom_job');
});

test('formatPreviousSourceField labels Drive, CDN, and external hosts', () => {
  assert.match(
    formatPreviousSourceField(
      'google_drive',
      'https://drive.google.com/file/d/1qS9xZwTLMw6R8mEUVeU0ArlIYI-iCu-R/view',
    ),
    /^Google Drive\nhttps:\/\//,
  );
  assert.equal(
    formatPreviousSourceField(
      'cdn',
      'https://api.tuforums.com/cdn/c95c3251-c859-4f6f-bbe8-9f2d226a109b',
    ),
    'CDN · c95c3251-c859-4f6f-bbe8-9f2d226a109b\nhttps://api.tuforums.com/cdn/c95c3251-c859-4f6f-bbe8-9f2d226a109b',
  );
  assert.equal(
    formatPreviousSourceField('external', 'https://files.example.com/level.zip'),
    'External (files.example.com)\nhttps://files.example.com/level.zip',
  );
});

test('formatChartStatsDiff only lists changed values', () => {
  const text = formatChartStatsDiff(
    { ...EMPTY_LEVEL_CHART_STATS, bpm: 180, tilecount: 800, levelLengthInMs: 90000 },
    { ...EMPTY_LEVEL_CHART_STATS, bpm: 175, tilecount: 800, levelLengthInMs: 92000, midspinCount: 4 },
  );
  assert.equal(text, 'BPM: 180 → 175\nMidspins: — → 4\nLength: 1:30 → 1:32');
});

test('formatChartStatsDiff uses blank old values and Unchanged', () => {
  assert.equal(
    formatChartStatsDiff(EMPTY_LEVEL_CHART_STATS, {
      ...EMPTY_LEVEL_CHART_STATS,
      tilecount: 842,
    }),
    'Tiles: — → 842',
  );
  assert.equal(
    formatChartStatsDiff(
      { ...EMPTY_LEVEL_CHART_STATS, bpm: 120 },
      { ...EMPTY_LEVEL_CHART_STATS, bpm: 120 },
    ),
    'Unchanged',
  );
});

test('formatChartStatsNew omits empty stats', () => {
  assert.equal(formatChartStatsNew(EMPTY_LEVEL_CHART_STATS), null);
  assert.equal(
    formatChartStatsNew({ ...EMPTY_LEVEL_CHART_STATS, bpm: 180, tilecount: 10 }),
    'BPM: 180\nTiles: 10',
  );
});

test('formatLengthMs and formatZipSize are compact', () => {
  assert.equal(formatLengthMs(65000), '1:05');
  assert.equal(formatLengthMs(3661000), '1:01:01');
  assert.equal(formatZipSize(12.4 * 1024 * 1024), '12.4 MB');
});

test('formatZipFilesField lists small packs and marks the target', () => {
  const text = formatZipFilesField({
    charts: [
      { name: 'main.adofai', relativePath: 'main.adofai' },
      { name: 'glitter.adofai', relativePath: 'pack/glitter.adofai' },
    ],
    audio: [{ name: 'song.ogg' }, { name: 'preview.mp3' }],
    targetRelativePath: 'pack/glitter.adofai',
  });
  assert.equal(
    text,
    [
      '2 charts · 2 audio',
      'Target: pack/glitter.adofai',
      'main.adofai',
      'pack/glitter.adofai ← target',
      'Audio: song.ogg, preview.mp3',
    ].join('\n'),
  );
});

test('formatZipFilesField groups large packs instead of listing every chart', () => {
  const charts = [
    { name: 'root.adofai', relativePath: 'root.adofai' },
    ...Array.from({ length: 48 }, (_, i) => ({
      name: `chart-${i}.adofai`,
      relativePath: `pack/very-long-chart-name-that-blows-the-budget-${i}.adofai`,
    })),
  ];
  charts[1].relativePath = 'pack/very-long-chart-name-that-blows-the-budget-0.adofai';
  const text = formatZipFilesField({
    charts,
    audio: Array.from({ length: 40 }, (_, i) => ({ name: `track-${i}-with-a-long-filename.ogg` })),
    targetRelativePath: 'pack/very-long-chart-name-that-blows-the-budget-0.adofai',
  });
  assert.match(text, /^49 charts · 40 audio/);
  assert.match(text, /Target: pack\/very-long-chart-name-that-blows-the-budget-0\.adofai/);
  assert.match(text, /\(root\) — 1/);
  assert.match(text, /pack\/ — 48 · target/);
  assert.equal(text.includes('← target'), false);
  assert.equal(text.includes('Audio:'), false);
  assert.ok(text.length <= DISCORD_FIELD_VALUE_MAX);
});

test('formatZipFilesField never exceeds Discord field length', () => {
  const charts = Array.from({ length: 200 }, (_, i) => ({
    name: `c${i}.adofai`,
    relativePath: `folder-${i}/chart-${i}.adofai`,
  }));
  const text = formatZipFilesField({
    charts,
    audio: [],
    targetRelativePath: 'folder-0/chart-0.adofai',
  });
  assert.ok(text.length <= DISCORD_FIELD_VALUE_MAX);
  assert.match(text, /^200 charts · 0 audio/);
});
