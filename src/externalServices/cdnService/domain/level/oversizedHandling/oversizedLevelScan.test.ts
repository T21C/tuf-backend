import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {scanJson5LevelText} from './json5LevelScan.js';
import {scanOversizedLevelFile} from './oversizedLevelScan.js';

const SETTINGS = `{
  bpm: 128,
  offset: 12,
  songFilename: 'track.ogg',
  song: 'Title',
  artist: 'Artist',
  author: 'Author'
}`;

function chart(opts?: {
  angles?: string;
  settings?: string;
  extra?: string;
  bom?: boolean;
}): string {
  const angles = opts?.angles ?? '[0, 999, 999, 999, 999, 999, 999, 999, 999, 999]';
  const settings = opts?.settings ?? SETTINGS;
  const extra = opts?.extra ?? '';
  const body = `{
  "angleData": ${angles},
  "settings": ${settings}${extra}
}`;
  return opts?.bom ? `\uFEFF${body}` : body;
}

void test('counts finite angleData numbers including midspins', () => {
  const r = scanJson5LevelText(chart());
  assert.equal(r.tilecount, 10);
  assert.equal(r.settings.bpm, 128);
  assert.equal(r.settings.offset, 12);
  assert.equal(r.settings.songFilename, 'track.ogg');
  assert.equal(r.settings.song, 'Title');
  assert.equal(r.settings.artist, 'Artist');
  assert.equal(r.settings.author, 'Author');
});

void test('counts decimals and does not drop 999 midspins', () => {
  const r = scanJson5LevelText(chart({angles: '[0, 999, 157.5, -180, 999]'}));
  assert.equal(r.tilecount, 5);
});

void test('JSON5: comments, trailing commas, single quotes, unquoted keys', () => {
  const text = `{
    // leading comment
    angleData: [0, 999, 90,], /* block */
    'settings': {
      bpm: 100,
      offset: 0,
      songFilename: "a.ogg",
      song: 's',
      artist: 'ar',
      author: 'au',
    },
  }`;
  const r = scanJson5LevelText(text);
  assert.equal(r.tilecount, 3);
  assert.equal(r.settings.bpm, 100);
  assert.equal(r.settings.songFilename, 'a.ogg');
});

void test('BOM is ignored', () => {
  const r = scanJson5LevelText(chart({bom: true}));
  assert.equal(r.tilecount, 10);
  assert.equal(r.settings.bpm, 128);
});

void test('vertical tab in a later EditorComment does not zero tilecount', () => {
  const extra = `,
  "actions": [
    { "floor": 0, "eventType": "EditorComment", "comment": "hello\u000b\u000bworld" }
  ]`;
  const r = scanJson5LevelText(chart({extra}));
  assert.equal(r.tilecount, 10);
  assert.equal(r.settings.bpm, 128);
  assert.equal(r.settings.song, 'Title');
});

void test('stops before trailing garbage after settings', () => {
  const extra = `,
  "actions": THIS IS NOT JSON {{{{ \u0000`;
  const r = scanJson5LevelText(chart({extra}));
  assert.equal(r.tilecount, 10);
  assert.equal(r.settings.author, 'Author');
});

void test('still correct when fed one byte at a time', () => {
  const r = scanJson5LevelText(chart({extra: ',\n  "actions": NOT JSON'}), 1);
  assert.equal(r.tilecount, 10);
  assert.equal(r.settings.bpm, 128);
});

void test('settings can appear before angleData', () => {
  const text = `{
    "settings": { "bpm": 90, "offset": 1, "songFilename": "x.ogg", "song": "s", "artist": "a", "author": "b" },
    "angleData": [0, 90, 180]
  }`;
  const r = scanJson5LevelText(text);
  assert.equal(r.tilecount, 3);
  assert.equal(r.settings.bpm, 90);
});

void test('pathData string length is used when angleData is absent', () => {
  const text = `{
    "pathData": "RUL!",
    "settings": { "bpm": 100, "offset": 0, "songFilename": "", "song": "", "artist": "", "author": "" }
  }`;
  const r = scanJson5LevelText(text);
  assert.equal(r.tilecount, 4);
  assert.equal(r.settings.bpm, 100);
});

void test('empty angleData is a valid zero tile source', () => {
  const r = scanJson5LevelText(chart({angles: '[]'}));
  assert.equal(r.tilecount, 0);
  assert.equal(r.settings.bpm, 128);
});

void test('scanOversizedLevelFile reads from disk and stops after settings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-scan-'));
  const file = path.join(dir, 'level.adofai');
  try {
    fs.writeFileSync(
      file,
      chart({
        extra: `,
  "actions": [{ "eventType": "EditorComment", "comment": "x\u000by" }],
  "decorations": ${'[' + '"x",'.repeat(1000) + '""]'}`,
      }),
    );
    const r = await scanOversizedLevelFile(file);
    assert.equal(r.tilecount, 10);
    assert.equal(r.settings.songFilename, 'track.ogg');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
