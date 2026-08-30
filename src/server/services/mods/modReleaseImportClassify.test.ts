import assert from 'node:assert/strict';
import test from 'node:test';

import {classifyModReleaseImport, isGithubComUrl} from './modReleaseImportClassify.js';

const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const HTML_HEAD = new Uint8Array([0x3c, 0x68, 0x74, 0x6d]);

void test('isGithubComUrl accepts github.com and www.github.com only', () => {
  assert.equal(isGithubComUrl('https://github.com/org/repo/releases/download/1/a.zip'), true);
  assert.equal(isGithubComUrl('https://www.github.com/org/repo'), true);
  assert.equal(isGithubComUrl('https://raw.githubusercontent.com/org/repo/main/a.zip'), false);
  assert.equal(isGithubComUrl('https://cdn.discordapp.com/attachments/1/2/a.zip'), false);
  assert.equal(isGithubComUrl('not a url'), false);
});

void test('classifyModReleaseImport skips CDN and GitHub without looking at the body', () => {
  assert.deepEqual(
    classifyModReleaseImport({
      downloadUrl: 'https://cdn.example/file',
      isCdn: true,
      headBytes: ZIP_MAGIC,
    }),
    {action: 'skip', reason: 'cdn'},
  );
  assert.deepEqual(
    classifyModReleaseImport({
      downloadUrl: 'https://github.com/org/repo/releases/download/1/a.zip',
      isCdn: false,
      headBytes: ZIP_MAGIC,
    }),
    {action: 'skip', reason: 'github'},
  );
});

void test('classifyModReleaseImport skips HTML and non-zip bodies', () => {
  assert.deepEqual(
    classifyModReleaseImport({
      downloadUrl: 'https://drive.google.com/uc?id=1',
      isCdn: false,
      contentType: 'text/html; charset=utf-8',
      headBytes: ZIP_MAGIC,
    }),
    {action: 'skip', reason: 'not-zip'},
  );
  assert.deepEqual(
    classifyModReleaseImport({
      downloadUrl: 'https://cdn.discordapp.com/attachments/1/2/a.zip',
      isCdn: false,
      contentType: 'application/octet-stream',
      headBytes: HTML_HEAD,
    }),
    {action: 'skip', reason: 'not-zip'},
  );
});

void test('classifyModReleaseImport ingests zip magic from non-GitHub hosts', () => {
  assert.deepEqual(
    classifyModReleaseImport({
      downloadUrl: 'https://cdn.discordapp.com/attachments/1/2/mod.zip',
      isCdn: false,
      contentType: 'application/zip',
      headBytes: ZIP_MAGIC,
    }),
    {action: 'ingest'},
  );
});
