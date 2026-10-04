import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';
import {resolveExternalReleaseUrls} from './modReleaseDownloads.js';

const common = 'https://github.com/org/mod/releases/download/v1/Mod.zip';
const windows = 'https://github.com/org/mod/releases/download/v1/Mod.Windows.zip';
const previous = {downloadUrl: common, platformDownloadUrls: {windows}};

void test('release partial updates preserve omitted URLs and can replace or clear platform maps', async () => {
  assert.deepEqual(await resolveExternalReleaseUrls({notes: 'changed'}, previous), previous);
  assert.deepEqual(await resolveExternalReleaseUrls({platformDownloadUrls: null}, previous), {
    downloadUrl: common, platformDownloadUrls: null,
  });
  assert.deepEqual(await resolveExternalReleaseUrls({downloadUrl: '', platformDownloadUrls: {windows}}, previous), {
    downloadUrl: '', platformDownloadUrls: {windows},
  });
  await assert.rejects(resolveExternalReleaseUrls({downloadUrl: '', platformDownloadUrls: null}, previous), /at least one ZIP/);
});

void test('explicit ZIPs do not depend on GitHub availability and direct assets are kept intact', async (t) => {
  const get = t.mock.method(axios, 'get', async () => {throw new Error('offline');});
  assert.equal((await resolveExternalReleaseUrls({githubUrl: 'https://github.com/org/mod/releases/tag/v1', downloadUrl: common})).downloadUrl, common);
  assert.equal((await resolveExternalReleaseUrls({githubUrl: windows})).downloadUrl, windows);
  await assert.rejects(resolveExternalReleaseUrls({githubUrl: windows.replace('https:', 'http:')}), /HTTPS ZIP URL/);
  assert.equal(get.mock.callCount(), 0);
});

void test('GitHub-only saves resolve actual platform ZIPs and reject ambiguous assets', async (t) => {
  const get = t.mock.method(axios, 'get', async () => ({data: {assets: [
    {name: 'Mod.Windows.zip', browser_download_url: windows},
  ]}}));
  assert.deepEqual(await resolveExternalReleaseUrls({githubUrl: 'https://github.com/org/mod/releases/tag/v1'}), {
    downloadUrl: '', platformDownloadUrls: {windows},
  });
  get.mock.mockImplementation(async () => ({data: {assets: [
    {name: 'one.zip', browser_download_url: common.replace('Mod.zip', 'one.zip')},
    {name: 'two.zip', browser_download_url: common.replace('Mod.zip', 'two.zip')},
  ]}}));
  await assert.rejects(resolveExternalReleaseUrls({githubUrl: 'https://github.com/org/mod/releases/tag/v1'}), /Multiple ZIP assets/);
});
